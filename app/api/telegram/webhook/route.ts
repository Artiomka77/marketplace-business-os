import { NextResponse } from "next/server";

import { rejectUnauthorizedTelegramWebhook } from "@/lib/security/telegramWebhookAuth";
import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  parseTelegramFinanceMessage,
  type ParsedFinanceOperation,
} from "@/lib/telegram/financeBotParser";
import {
  buildDailyReport,
  formatDailyReportForTelegram,
  type DailyReportPeriodPreset,
} from "@/lib/telegram/dailyReport";
import { generateDailyReportAiAnalysis } from "@/lib/telegram/dailyReportAi";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type TelegramChat = {
  id: number | string;
};

type TelegramUser = {
  id: number | string;
  first_name?: string;
  username?: string;
};

type TelegramMessage = {
  message_id: number;
  text?: string;
  chat: TelegramChat;
  from?: TelegramUser;
};

type TelegramCallbackQuery = {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
};

type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
};

type StoredDraftJson = {
  status: "PENDING" | "SUCCESS" | "CANCELLED";
  chatId: string;
  userId: string | null;
  rawText: string;
  operation: ParsedFinanceOperation;
  pendingEdit?: "AMOUNT" | "COMMENT" | null;
};

const CATEGORY_TYPE_TO_OPERATION_TYPE: Record<string, string> = {
  INCOME: "INCOME",
  EXPENSE: "EXPENSE",
  TRANSFER: "TRANSFER",
  FINANCING: "FINANCING",
  PERSONAL: "PERSONAL",
};

function getBotToken() {
  return process.env.TELEGRAM_BOT_TOKEN ?? "";
}

function getWebhookSecret() {
  return process.env.TELEGRAM_WEBHOOK_SECRET ?? "";
}

function getAllowedChatIds() {
  return String(process.env.TELEGRAM_ALLOWED_CHAT_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function isChatAllowed(chatId: string) {
  const allowedChatIds = getAllowedChatIds();

  if (allowedChatIds.length === 0) {
    return true;
  }

  return allowedChatIds.includes(chatId);
}

function formatMoney(value: number) {
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "RUB",
    maximumFractionDigits: 0,
  }).format(value);
}


function normalizeTelegramDate(value: string) {
  const match = value.trim().match(/^(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{2}|\d{4})$/);
  if (!match) return null;

  const day = Number(match[1]);
  const month = Number(match[2]);
  const rawYear = Number(match[3]);
  const year = rawYear < 100 ? 2000 + rawYear : rawYear;

  if (day < 1 || day > 31 || month < 1 || month > 12 || year < 2020) {
    return null;
  }

  return `${year.toString().padStart(4, "0")}-${month
    .toString()
    .padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
}

function parseReportDateRangeFromText(text: string) {
  const normalized = text.trim().replace(/\s+/g, " ");
  const match = normalized.match(
    /(\d{1,2}[.\-/]\d{1,2}[.\-/]\d{2,4})\s*(?:-|—|–|по|до|\s)\s*(\d{1,2}[.\-/]\d{1,2}[.\-/]\d{2,4})/i
  );

  if (!match) return null;

  const from = normalizeTelegramDate(match[1]);
  const to = normalizeTelegramDate(match[2]);

  if (!from || !to) return null;

  return from <= to ? { from, to } : { from: to, to: from };
}

function operationTypeLabel(type: string) {
  if (type === "INCOME") return "Поступление";
  if (type === "EXPENSE") return "Расход";
  if (type === "TRANSFER") return "Перевод";
  if (type === "FINANCING") return "Финансирование";
  if (type === "PERSONAL") return "Вывод собственника";
  return type || "—";
}

function formatDate(value: string) {
  return new Date(value).toLocaleDateString("ru-RU");
}

function parseAmountFromText(text: string) {
  const match = text.match(/\d[\d\s]*(?:[,.]\d{1,2})?/);

  if (!match) return null;

  const number = Number(
    match[0]
      .replace(/\s/g, "")
      .replace(",", ".")
      .replace(/[^\d.-]/g, "")
  );

  if (!Number.isFinite(number) || number <= 0) return null;

  return number;
}

function formatDraftMessage(operation: ParsedFinanceOperation) {
  const warningText =
    operation.warnings.length > 0
      ? `\n\n⚠️ ${operation.warnings.join("\n⚠️ ")}`
      : "";

  return [
    "Проверь операцию:",
    "",
    `Тип: ${operationTypeLabel(operation.operationType)}`,
    `Компания: ${operation.companyName}`,
    `Статья: ${operation.category}`,
    `Счёт: ${operation.bankAccount ?? "—"}`,
    `Сумма: ${formatMoney(operation.amount)}`,
    `Дата: ${formatDate(operation.operationDate)}`,
    operation.project ? `Проект: ${operation.project}` : null,
    operation.comment ? `Комментарий: ${operation.comment}` : null,
    warningText,
  ]
    .filter((line) => line !== null)
    .join("\n");
}

function formatSavedMessage(operation: ParsedFinanceOperation) {
  return [
    "✅ Операция сохранена",
    "",
    `${operationTypeLabel(operation.operationType)} · ${formatMoney(
      operation.amount
    )}`,
    `${operation.companyName} · ${operation.category}`,
    operation.bankAccount ? `Счёт: ${operation.bankAccount}` : null,
    operation.comment ? `Комментарий: ${operation.comment}` : null,
  ]
    .filter((line) => line !== null)
    .join("\n");
}

function formatOperationLine(operation: {
  operationDate: Date;
  operationType: string;
  companyName: string;
  category: string;
  amount: unknown;
  bankAccount?: string | null;
  comment?: string | null;
}) {
  const date = operation.operationDate.toLocaleDateString("ru-RU");
  const amount = Number(operation.amount ?? 0);

  return [
    `${date} · ${operationTypeLabel(operation.operationType)} · ${formatMoney(
      amount
    )}`,
    `${operation.companyName} · ${operation.category}`,
    operation.bankAccount ? `Счёт: ${operation.bankAccount}` : null,
    operation.comment ? `Комментарий: ${operation.comment}` : null,
  ]
    .filter((line) => line !== null)
    .join("\n");
}

function startOfToday() {
  const now = new Date();

  return new Date(
    Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0)
  );
}

function endOfToday() {
  const now = new Date();

  return new Date(
    Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999)
  );
}

function mainReplyKeyboard() {
  return {
    keyboard: [
      [{ text: "🏠 Главное меню" }],
      [{ text: "➕ Добавить расход" }, { text: "💰 Добавить поступление" }],
      [{ text: "👤 Вывод собственника" }, { text: "🏦 Кредит / займ" }],
      [{ text: "📊 Отчёт собственника" }],
      [{ text: "📋 Последние операции" }, { text: "📅 Сегодня" }],
      [{ text: "↩️ Отменить последнюю" }],
    ],
    resize_keyboard: true,
    one_time_keyboard: false,
    input_field_placeholder: "Напишите операцию: закуп 15000 петров сбер",
  };
}

function visualMenuInlineKeyboard() {
  return {
    inline_keyboard: [
      [
        {
          text: "➕ Расход",
          callback_data: "quick_help:expense",
        },
        {
          text: "💰 Поступление",
          callback_data: "quick_help:income",
        },
      ],
      [
        {
          text: "👤 Вывод",
          callback_data: "quick_help:personal",
        },
        {
          text: "🏦 Кредит",
          callback_data: "quick_help:credit",
        },
      ],
      [
        {
          text: "📊 Отчёт",
          callback_data: "report_menu",
        },
      ],
      [
        {
          text: "📋 Последние",
          callback_data: "quick_last",
        },
        {
          text: "📅 Сегодня",
          callback_data: "quick_today",
        },
      ],
      [
        {
          text: "↩️ Отменить последнюю",
          callback_data: "quick_undo",
        },
      ],
    ],
  };
}

function reportPeriodInlineKeyboard() {
  return {
    inline_keyboard: [
      [
        {
          text: "Сегодня",
          callback_data: "report:today",
        },
        {
          text: "Вчера",
          callback_data: "report:yesterday",
        },
      ],
      [
        {
          text: "Текущая неделя",
          callback_data: "report:current_week",
        },
        {
          text: "Прошлая неделя",
          callback_data: "report:previous_week",
        },
      ],
      [
        {
          text: "Текущий месяц",
          callback_data: "report:current_month",
        },
        {
          text: "Прошлый месяц",
          callback_data: "report:previous_month",
        },
      ],
      [
        {
          text: "Последние 30 дней",
          callback_data: "report:last_30_days",
        },
        {
          text: "Текущий квартал",
          callback_data: "report:current_quarter",
        },
      ],
      [
        {
          text: "С начала года",
          callback_data: "report:ytd",
        },
        {
          text: "Выбрать период",
          callback_data: "report_custom_help",
        },
      ],
      [
        {
          text: "🤖 Ответ ИИ",
          callback_data: "report_ai_menu",
        },
      ],
      [
        {
          text: "← Главное меню",
          callback_data: "quick_menu",
        },
      ],
    ],
  };
}
function aiReportPeriodInlineKeyboard() {
  return {
    inline_keyboard: [
      [
        {
          text: "🤖 Сегодня",
          callback_data: "report_ai:today",
        },
        {
          text: "🤖 Вчера",
          callback_data: "report_ai:yesterday",
        },
      ],
      [
        {
          text: "🤖 Текущая неделя",
          callback_data: "report_ai:current_week",
        },
        {
          text: "🤖 Прошлая неделя",
          callback_data: "report_ai:previous_week",
        },
      ],
      [
        {
          text: "🤖 Текущий месяц",
          callback_data: "report_ai:current_month",
        },
        {
          text: "🤖 Прошлый месяц",
          callback_data: "report_ai:previous_month",
        },
      ],
      [
        {
          text: "🤖 Последние 30 дней",
          callback_data: "report_ai:last_30_days",
        },
        {
          text: "🤖 Текущий квартал",
          callback_data: "report_ai:current_quarter",
        },
      ],
      [
        {
          text: "🤖 С начала года",
          callback_data: "report_ai:ytd",
        },
      ],
      [
        {
          text: "← К обычным отчётам",
          callback_data: "report_menu",
        },
        {
          text: "← Главное меню",
          callback_data: "quick_menu",
        },
      ],
    ],
  };
}
function getReportMenuMessage() {
  return [
    "📊 Отчёт собственника",
    "",
    "Выберите период:",
    "",
    "• Сегодня — оперативная картина текущего дня",
    "• Вчера — ежедневная сверка",
    "• Текущая неделя — темп недели",
    "• Прошлая неделя — закрытая неделя понедельник–воскресенье",
    "• Текущий месяц — управленческий месяц",
    "• Прошлый месяц — финальный месяц для анализа",
    "• Последние 30 дней — rolling-динамика",
    "• Текущий квартал — квартальная картина",
    "• С начала года — накопленный итог",
    "• Выбрать период — напишите даты вручную",
    "",
    "Для произвольного периода напишите, например:",
    "22.06.2026-28.06.2026",
    "или",
    "22.06.2026 28.06.2026",
    "",
    "В каждом отчёте добавлена динамика в процентах к аналогичному предыдущему периоду.",
    "🤖 Ответ ИИ — выбрать период и получить AI-анализ.",
  ].join("\n");
}
function getAiReportMenuMessage() {
  return [
    "🤖 Ответ ИИ",
    "",
    "Выберите период для AI-анализа:",
    "",
    "ИИ возьмёт обычный отчёт за выбранный период и добавит краткий управленческий вывод:",
    "• что произошло;",
    "• главный риск;",
    "• что проверить;",
    "• что сделать сегодня;",
    "• где возможна проблема в данных.",
  ].join("\n");
}

function getVisualMenuMessage(chatId: string) {
  return [
    "🏠 AvoroFin — главное меню",
    "",
    "Выберите действие кнопкой ниже или просто напишите операцию обычным текстом.",
    "",
    "✍️ Примеры:",
    "• закуп 15000 петров сбер упаковка",
    "• поступило 4881996 лебедева ozon выручка",
    "• вывод 50000 продукты сбер",
    "• тело кредит 17792 альфа",
    "• интернет 1700",
    "",
    "После ввода я покажу карточку проверки:",
    "✅ сохранить · ✏️ изменить · ❌ отменить",
    "",
    `chat id: ${chatId}`,
  ].join("\n");
}

function getQuickHelpMessage(type: string) {
  if (type === "expense") {
    return [
      "➕ Добавить расход",
      "",
      "Напишите расход обычным текстом.",
      "",
      "Примеры:",
      "• закуп 15000 петров сбер упаковка",
      "• реклама 5000 ozon",
      "• интернет 1700",
      "• фулфилмент 12500",
    ].join("\n");
  }

  if (type === "income") {
    return [
      "💰 Добавить поступление",
      "",
      "Напишите поступление обычным текстом.",
      "",
      "Пример:",
      "• поступило 4881996 лебедева ozon выручка",
    ].join("\n");
  }

  if (type === "personal") {
    return [
      "👤 Вывод собственника",
      "",
      "Напишите вывод обычным текстом.",
      "",
      "Пример:",
      "• вывод 50000 продукты сбер",
    ].join("\n");
  }

  if (type === "credit") {
    return [
      "🏦 Кредит / займ",
      "",
      "Напишите кредитную операцию обычным текстом.",
      "",
      "Примеры:",
      "• тело кредит 17792 альфа",
      "• проценты кредит 4229 альфа",
    ].join("\n");
  }

  return "Напишите операцию обычным текстом.";
}

function getHelpMessage(chatId: string) {
  return [
    "🏠 AvoroFin — главное меню",
    "",
    "Быстро добавляйте финансовые операции обычным сообщением.",
    "",
    "━━━━━━━━━━━━━━",
    "✍️ Быстрый ввод",
    "",
    "Напишите так:",
    "• закуп 15000 петров сбер упаковка",
    "• поступило 4881996 лебедева ozon выручка",
    "• вывод 50000 продукты сбер",
    "• тело кредит 17792 альфа",
    "• интернет 1700",
    "",
    "Я разберу сообщение, покажу карточку проверки и сохраню только после вашего подтверждения.",
    "",
    "━━━━━━━━━━━━━━",
    "⚡ Быстрые кнопки",
    "",
    "➕ Добавить расход — пример расхода",
    "💰 Добавить поступление — пример поступления",
    "👤 Вывод собственника — личный вывод",
    "🏦 Кредит / займ — тело и проценты кредита",
    "📊 Отчёт собственника — сводка за нужный период",
    "🤖 Ответ ИИ — выбрать период и получить AI-анализ",
    "📋 Последние операции — последние операции из Telegram",
    "📅 Сегодня — операции за сегодня",
    "↩️ Отменить последнюю — удалить последнюю Telegram-операцию",
    "",
    "━━━━━━━━━━━━━━",
    "⌨️ Команды",
    "",
    "/menu — главное меню",
    "/add — как добавить операцию",
    "/last — последние операции",
    "/today — операции за сегодня",
    "/daily — сводка собственника за вчера",
    "/report — выбрать период отчёта",
    "/report_ai — выбрать период для AI-анализа",
    "/report_today — отчёт за сегодня",
    "/report_yesterday — отчёт за вчера",
    "/report_current_week — текущая неделя",
    "/report_previous_week — прошлая закрытая неделя",
    "/report_current_month — текущий месяц",
    "/report_previous_month — прошлый месяц",
    "/report_30d — последние 30 дней",
    "/report_current_quarter — текущий квартал",
    "/report_ytd — с начала года",
    "22.06.2026-28.06.2026 — произвольный период",
    "/undo — отменить последнюю",
    "/id — показать chat id",
    "",
    `Ваш chat id: ${chatId}`,
  ].join("\n");
}

function confirmKeyboard(draftId: string) {
  return {
    inline_keyboard: [
      [
        {
          text: "✅ Сохранить",
          callback_data: `save:${draftId}`,
        },
        {
          text: "❌ Отмена",
          callback_data: `cancel:${draftId}`,
        },
      ],
      [
        {
          text: "🏢 Компания",
          callback_data: `edit_company:${draftId}`,
        },
        {
          text: "🏷 Статья",
          callback_data: `edit_category:${draftId}`,
        },
        {
          text: "💳 Счёт",
          callback_data: `edit_account:${draftId}`,
        },
      ],
      [
        {
          text: "💰 Сумма",
          callback_data: `edit_amount:${draftId}`,
        },
        {
          text: "📝 Комментарий",
          callback_data: `edit_comment:${draftId}`,
        },
      ],
    ],
  };
}

async function telegramRequest(method: string, payload: Record<string, unknown>) {
  const token = getBotToken();

  if (!token) {
    console.error("TELEGRAM_BOT_TOKEN is not configured");
    return null;
  }

  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text();
    console.error("TELEGRAM_API_ERROR", method, response.status, text);
  }

  return response;
}


// DIRECT_TELEGRAM_WEBHOOK_RESPONSE_SIMPLE_COMMANDS_V1
// Простые команды отвечают прямо в webhook response.
// Это убирает зависимость /id, /menu и выбора меню отчёта от отдельного fetch к api.telegram.org/sendMessage.
function directTelegramWebhookSendMessage(
  chatId: string,
  text: string,
  replyMarkup?: Record<string, unknown>
) {
  return NextResponse.json({
    method: "sendMessage",
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}

function buildDirectTelegramWebhookResponse(update: TelegramUpdate) {
  const message = update.message;

  if (!message?.text) {
    return null;
  }

  const chatId = String(message.chat.id);

  if (!isChatAllowed(chatId)) {
    return directTelegramWebhookSendMessage(chatId, "Доступ запрещён");
  }

  const rawText = message.text.trim();
  const normalizedText = rawText
    .replace(/\s+/g, " ")
    .toLowerCase()
    .replaceAll("ё", "е");

  if (normalizedText.startsWith("/id")) {
    return directTelegramWebhookSendMessage(chatId, `Ваш chat id: ${chatId}`);
  }

  if (
    normalizedText.startsWith("/start") ||
    normalizedText.startsWith("/help") ||
    normalizedText.startsWith("/menu") ||
    normalizedText === "меню" ||
    normalizedText === "главное меню" ||
    normalizedText === "🏠 главное меню"
  ) {
    return directTelegramWebhookSendMessage(
      chatId,
      getHelpMessage(chatId),
      mainReplyKeyboard()
    );
  }

  if (
    normalizedText === "/report" ||
    normalizedText === "отчет собственника" ||
    normalizedText === "📊 отчет собственника"
  ) {
    return directTelegramWebhookSendMessage(
      chatId,
      getReportMenuMessage(),
      reportPeriodInlineKeyboard()
    );
  }

  return null;
}


async function sendMessage(
  chatId: string,
  text: string,
  replyMarkup?: Record<string, unknown>
) {
  return telegramRequest("sendMessage", {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}

async function editMessageText(params: {
  chatId: string;
  messageId: number;
  text: string;
  replyMarkup?: Record<string, unknown>;
}) {
  return telegramRequest("editMessageText", {
    chat_id: params.chatId,
    message_id: params.messageId,
    text: params.text,
    disable_web_page_preview: true,
    reply_markup: params.replyMarkup ?? {
      inline_keyboard: [],
    },
  });
}

async function answerCallbackQuery(callbackQueryId: string, text?: string) {
  return telegramRequest("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    ...(text ? { text } : {}),
  });
}

function asStoredDraftJson(value: Prisma.JsonValue): StoredDraftJson | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const candidate = value as Partial<StoredDraftJson>;

  if (!candidate.operation || !candidate.chatId) {
    return null;
  }

  return candidate as StoredDraftJson;
}

async function getDraft(draftId: string) {
  const importSession = await prisma.importSession.findUnique({
    where: {
      id: draftId,
    },
  });

  const draft = importSession?.previewJson
    ? asStoredDraftJson(importSession.previewJson)
    : null;

  return {
    importSession,
    draft,
  };
}

async function updateDraft(draftId: string, draft: StoredDraftJson) {
  await prisma.importSession.update({
    where: {
      id: draftId,
    },
    data: {
      companyName: draft.operation.companyName,
      previewJson: draft as unknown as Prisma.InputJsonValue,
    },
  });
}

async function findPendingEditDraft(chatId: string) {
  const importSessions = await prisma.importSession.findMany({
    where: {
      reportType: "TELEGRAM_FINANCE_DRAFT",
      status: "PENDING",
    },
    orderBy: {
      createdAt: "desc",
    },
    take: 20,
  });

  for (const importSession of importSessions) {
    const draft = importSession.previewJson
      ? asStoredDraftJson(importSession.previewJson)
      : null;

    if (draft?.chatId === chatId && draft.pendingEdit) {
      return {
        importSession,
        draft,
      };
    }
  }

  return null;
}

async function handlePendingTextEdit(
  message: TelegramMessage,
  draftId: string,
  draft: StoredDraftJson
) {
  const chatId = String(message.chat.id);
  const text = String(message.text ?? "").trim();

  if (draft.pendingEdit === "AMOUNT") {
    const amount = parseAmountFromText(text);

    if (!amount) {
      await sendMessage(
        chatId,
        [
          "Не вижу новую сумму.",
          "",
          "Напишите одним числом, например:",
          "15000",
        ].join("\n")
      );
      return;
    }

    const updatedDraft: StoredDraftJson = {
      ...draft,
      pendingEdit: null,
      operation: {
        ...draft.operation,
        amount,
      },
    };

    await updateDraft(draftId, updatedDraft);

    await sendMessage(
      chatId,
      formatDraftMessage(updatedDraft.operation),
      confirmKeyboard(draftId)
    );

    return;
  }

  if (draft.pendingEdit === "COMMENT") {
    const normalizedText = text.toLowerCase().trim();
    const comment =
      normalizedText === "-" ||
      normalizedText === "нет" ||
      normalizedText === "без комментария"
        ? null
        : text;

    const updatedDraft: StoredDraftJson = {
      ...draft,
      pendingEdit: null,
      operation: {
        ...draft.operation,
        comment,
      },
    };

    await updateDraft(draftId, updatedDraft);

    await sendMessage(
      chatId,
      formatDraftMessage(updatedDraft.operation),
      confirmKeyboard(draftId)
    );
  }
}

async function findTelegramImportSessionsForChat(params: {
  chatId: string;
  status?: string;
  take?: number;
}) {
  const sessions = await prisma.importSession.findMany({
    where: {
      reportType: "TELEGRAM_FINANCE_DRAFT",
      ...(params.status ? { status: params.status } : {}),
    },
    orderBy: {
      createdAt: "desc",
    },
    take: params.take ?? 30,
  });

  return sessions.filter((session) => {
    const draft = session.previewJson
      ? asStoredDraftJson(session.previewJson)
      : null;

    return draft?.chatId === params.chatId;
  });
}

async function sendLastOperations(chatId: string) {
  const sessions = await findTelegramImportSessionsForChat({
    chatId,
    status: "SUCCESS",
    take: 30,
  });

  if (sessions.length === 0) {
    await sendMessage(chatId, "Пока нет сохранённых операций из Telegram.");
    return;
  }

  const operations = await prisma.financeTransaction.findMany({
    where: {
      sourceType: "TELEGRAM_BOT",
      sourceId: {
        in: sessions.map((session) => session.id),
      },
    },
    orderBy: {
      createdAt: "desc",
    },
    take: 5,
  });

  if (operations.length === 0) {
    await sendMessage(chatId, "Пока нет сохранённых операций из Telegram.");
    return;
  }

  await sendMessage(
    chatId,
    [
      "Последние операции из Telegram:",
      "",
      ...operations.map((operation, index) => {
        return `${index + 1}) ${formatOperationLine(operation)}`;
      }),
    ].join("\n\n")
  );
}

async function sendTodayOperations(chatId: string) {
  const sessions = await findTelegramImportSessionsForChat({
    chatId,
    status: "SUCCESS",
    take: 100,
  });

  const operations = await prisma.financeTransaction.findMany({
    where: {
      sourceType: "TELEGRAM_BOT",
      sourceId: {
        in: sessions.map((session) => session.id),
      },
      operationDate: {
        gte: startOfToday(),
        lte: endOfToday(),
      },
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  if (operations.length === 0) {
    await sendMessage(chatId, "Сегодня через Telegram операций пока нет.");
    return;
  }

  const totalIncome = operations
    .filter((operation) => operation.operationType === "INCOME")
    .reduce((sum, operation) => sum + Number(operation.amount ?? 0), 0);

  const totalOutflow = operations
    .filter((operation) => operation.operationType !== "INCOME")
    .reduce((sum, operation) => sum + Number(operation.amount ?? 0), 0);

  await sendMessage(
    chatId,
    [
      "Операции за сегодня из Telegram:",
      "",
      `Поступления: ${formatMoney(totalIncome)}`,
      `Списания: ${formatMoney(totalOutflow)}`,
      "",
      ...operations.slice(0, 10).map((operation, index) => {
        return `${index + 1}) ${formatOperationLine(operation)}`;
      }),
    ].join("\n\n")
  );
}

async function sendDailyOwnerReport(
  chatId: string,
  preset: DailyReportPeriodPreset = "yesterday",
  useAi = false
) {
  const report = await buildDailyReport({ preset });
  const baseMessage = formatDailyReportForTelegram(report);

  if (!useAi) {
    await sendMessage(chatId, baseMessage);
    return;
  }

  const aiResult = await generateDailyReportAiAnalysis(report);

  if (aiResult.text) {
    await sendMessage(chatId, `${baseMessage}\n\n${aiResult.text}`);
    return;
  }

  await sendMessage(
    chatId,
    [
      baseMessage,
      "",
      "🤖 AI-анализ временно недоступен.",
      aiResult.error ? `Причина: ${aiResult.error}` : null,
    ]
      .filter((line) => line !== null)
      .join("\n")
  );
}


async function sendDailyOwnerReportForRange(
  chatId: string,
  from: string,
  to: string,
  useAi = false
) {
  const report = await buildDailyReport({ from, to });
  const baseMessage = formatDailyReportForTelegram(report);

  if (!useAi) {
    await sendMessage(chatId, baseMessage);
    return;
  }

  const aiResult = await generateDailyReportAiAnalysis(report);

  if (aiResult.text) {
    await sendMessage(chatId, `${baseMessage}\n\n${aiResult.text}`);
    return;
  }

  await sendMessage(
    chatId,
    [
      baseMessage,
      "",
      "🤖 AI-анализ временно недоступен.",
      aiResult.error ? `Причина: ${aiResult.error}` : null,
    ]
      .filter((line) => line !== null)
      .join("\n")
  );
}

async function sendReportMenu(chatId: string) {
  await sendMessage(chatId, getReportMenuMessage(), reportPeriodInlineKeyboard());
}

async function sendAiReportMenu(chatId: string) {
  await sendMessage(
    chatId,
    getAiReportMenuMessage(),
    aiReportPeriodInlineKeyboard()
  );
}

async function sendUndoLastOperationPrompt(chatId: string) {
  const sessions = await findTelegramImportSessionsForChat({
    chatId,
    status: "SUCCESS",
    take: 20,
  });

  if (sessions.length === 0) {
    await sendMessage(chatId, "Нет сохранённых Telegram-операций для удаления.");
    return;
  }

  const operation = await prisma.financeTransaction.findFirst({
    where: {
      sourceType: "TELEGRAM_BOT",
      sourceId: {
        in: sessions.map((session) => session.id),
      },
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  if (!operation?.sourceId) {
    await sendMessage(chatId, "Нет сохранённых Telegram-операций для удаления.");
    return;
  }

  await sendMessage(
    chatId,
    [
      "Удалить последнюю Telegram-операцию?",
      "",
      formatOperationLine(operation),
    ].join("\n\n"),
    {
      inline_keyboard: [
        [
          {
            text: "✅ Удалить",
            callback_data: `undo:${operation.sourceId}`,
          },
          {
            text: "❌ Оставить",
            callback_data: "undo_cancel",
          },
        ],
      ],
    }
  );
}

async function undoSavedOperation(
  callbackQuery: TelegramCallbackQuery,
  sourceId: string
) {
  const message = callbackQuery.message;
  const chatId = message?.chat.id ? String(message.chat.id) : null;

  if (!chatId || !isChatAllowed(chatId)) {
    await answerCallbackQuery(callbackQuery.id, "Доступ запрещён");
    return;
  }

  const importSession = await prisma.importSession.findUnique({
    where: {
      id: sourceId,
    },
  });

  const draft = importSession?.previewJson
    ? asStoredDraftJson(importSession.previewJson)
    : null;

  if (!importSession || draft?.chatId !== chatId) {
    await answerCallbackQuery(callbackQuery.id, "Операция не найдена");
    return;
  }

  const deleted = await prisma.financeTransaction.deleteMany({
    where: {
      sourceType: "TELEGRAM_BOT",
      sourceId,
    },
  });

  await prisma.importSession.update({
    where: {
      id: sourceId,
    },
    data: {
      status: "DELETED",
    },
  });

  await answerCallbackQuery(callbackQuery.id, "Удалено");

  if (message?.message_id) {
    await editMessageText({
      chatId,
      messageId: message.message_id,
      text:
        deleted.count > 0
          ? "✅ Последняя Telegram-операция удалена"
          : "Операция уже была удалена",
    });
  } else {
    await sendMessage(chatId, "✅ Последняя Telegram-операция удалена");
  }
}

async function createDraftFromMessage(message: TelegramMessage) {
  const chatId = String(message.chat.id);
  const userId = message.from?.id ? String(message.from.id) : null;
  const text = message.text ?? "";

  if (!isChatAllowed(chatId)) {
    await sendMessage(
      chatId,
      [
        "Доступ к боту пока не разрешён.",
        "",
        `Ваш chat id: ${chatId}`,
        "Добавьте его в TELEGRAM_ALLOWED_CHAT_IDS.",
      ].join("\n")
    );
    return;
  }

  if (
    text.startsWith("/start") ||
    text.startsWith("/menu") ||
    text.trim().toLowerCase() === "🏠 меню" ||
    text.trim().toLowerCase() === "🏠 главное меню" ||
    text.trim().toLowerCase() === "меню" ||
    text.trim().toLowerCase() === "главное меню"
  ) {
    await sendMessage(
      chatId,
      getVisualMenuMessage(chatId),
      visualMenuInlineKeyboard()
    );

    await sendMessage(chatId, "Быстрые кнопки включены 👇", mainReplyKeyboard());
    return;
  }

  if (text.startsWith("/help")) {
    await sendMessage(chatId, getHelpMessage(chatId), mainReplyKeyboard());
    return;
  }

  if (text.startsWith("/id")) {
    await sendMessage(chatId, `Ваш chat id: ${chatId}`);
    return;
  }

  const normalizedCommandText = text.toLowerCase().trim();

  if (
    normalizedCommandText === "/add" ||
    normalizedCommandText === "/operation" ||
    normalizedCommandText.includes("добавить операцию")
  ) {
    await sendMessage(
      chatId,
      [
        "Напишите операцию обычным текстом.",
        "",
        "Примеры:",
        "закуп 15000 петров сбер упаковка",
        "поступило 4881996 лебедева ozon выручка",
        "вывод 50000 продукты сбер",
        "тело кредит 17792 альфа",
      ].join("\n"),
      mainReplyKeyboard()
    );
    return;
  }

  if (
    normalizedCommandText === "/last" ||
    normalizedCommandText.includes("последние")
  ) {
    await sendLastOperations(chatId);
    return;
  }

  if (
    normalizedCommandText === "/today" ||
    normalizedCommandText.includes("сегодня")
  ) {
    await sendTodayOperations(chatId);
    return;
  }

  if (
    normalizedCommandText === "/report" ||
    normalizedCommandText === "📊 отчёт собственника" ||
    normalizedCommandText.includes("отчет собственника") ||
    normalizedCommandText.includes("отчёт собственника")
  ) {
    await sendReportMenu(chatId);
    return;
  }

  if (
    normalizedCommandText === "/report_ai" ||
    normalizedCommandText === "/daily_ai" ||
    normalizedCommandText === "/ai" ||
    normalizedCommandText.includes("ответ искусственного интеллекта") ||
    normalizedCommandText.includes("ответ ии") ||
    normalizedCommandText.includes("ответ ai") ||
    normalizedCommandText.includes("ai-ответ") ||
    normalizedCommandText.includes("ии-анализ") ||
    normalizedCommandText.includes("ai-анализ") ||
    normalizedCommandText.includes("ai анализ")
  ) {
    await sendMessage(
      chatId,
      getAiReportMenuMessage(),
      aiReportPeriodInlineKeyboard()
    );
    return;
  }

  const customReportRange = parseReportDateRangeFromText(text);

  if (customReportRange) {
    await sendDailyOwnerReportForRange(
      chatId,
      customReportRange.from,
      customReportRange.to
    );
    return;
  }

  if (
    normalizedCommandText === "/report_today"
  ) {
    await sendDailyOwnerReport(chatId, "today");
    return;
  }

  if (normalizedCommandText === "/report_previous_week") {
    await sendDailyOwnerReport(chatId, "previous_week");
    return;
  }

  if (normalizedCommandText === "/report_current_month") {
    await sendDailyOwnerReport(chatId, "current_month");
    return;
  }

  if (normalizedCommandText === "/report_previous_month") {
    await sendDailyOwnerReport(chatId, "previous_month");
    return;
  }

  if (normalizedCommandText === "/report_last_30_days") {
    await sendDailyOwnerReport(chatId, "last_30_days");
    return;
  }

  if (normalizedCommandText === "/report_current_quarter") {
    await sendDailyOwnerReport(chatId, "current_quarter");
    return;
  }

  if (normalizedCommandText === "/report_ytd") {
    await sendDailyOwnerReport(chatId, "ytd");
    return;
  }

  if (
    normalizedCommandText === "/daily" ||
    normalizedCommandText === "/report_yesterday" ||
    normalizedCommandText.includes("сводка за вчера") ||
    normalizedCommandText.includes("ежедневная сводка")
  ) {
    await sendDailyOwnerReport(chatId, "yesterday");
    return;
  }

  if (
    normalizedCommandText === "/report_day_before_yesterday" ||
    normalizedCommandText === "/report_before_yesterday" ||
    normalizedCommandText.includes("позавчера")
  ) {
    await sendDailyOwnerReport(chatId, "day_before_yesterday");
    return;
  }

  if (normalizedCommandText === "/report_3d") {
    await sendDailyOwnerReport(chatId, "3d");
    return;
  }

  if (
    normalizedCommandText === "/report_current_week" ||
    normalizedCommandText === "/report_week"
  ) {
    await sendDailyOwnerReport(chatId, "current_week");
    return;
  }

  if (normalizedCommandText === "/report_7d") {
    await sendDailyOwnerReport(chatId, "7d");
    return;
  }

  if (normalizedCommandText === "/report_15d") {
    await sendDailyOwnerReport(chatId, "15d");
    return;
  }

  if (normalizedCommandText === "/report_month") {
    await sendDailyOwnerReport(chatId, "current_month");
    return;
  }

  if (normalizedCommandText === "/report_30d") {
    await sendDailyOwnerReport(chatId, "last_30_days");
    return;
  }

  if (
    normalizedCommandText === "/report_3m" ||
    normalizedCommandText === "/report_90d"
  ) {
    await sendDailyOwnerReport(chatId, "3m");
    return;
  }

  if (normalizedCommandText === "/report_6m") {
    await sendDailyOwnerReport(chatId, "6m");
    return;
  }

  if (
    normalizedCommandText === "/report_year" ||
    normalizedCommandText === "/report_365d"
  ) {
    await sendDailyOwnerReport(chatId, "year");
    return;
  }

  if (
    normalizedCommandText === "/undo" ||
    normalizedCommandText.includes("отменить последнюю")
  ) {
    await sendUndoLastOperationPrompt(chatId);
    return;
  }

  if (
    normalizedCommandText === "➕ расход" ||
    normalizedCommandText === "➕ добавить расход"
  ) {
    await sendMessage(
      chatId,
      [
        "Напишите расход обычным текстом.",
        "",
        "Примеры:",
        "закуп 15000 петров сбер упаковка",
        "реклама 5000 ozon",
        "интернет 1700",
      ].join("\n")
    );
    return;
  }

  if (
    normalizedCommandText === "💰 поступление" ||
    normalizedCommandText === "💰 добавить поступление"
  ) {
    await sendMessage(
      chatId,
      [
        "Напишите поступление обычным текстом.",
        "",
        "Пример:",
        "поступило 4881996 лебедева ozon выручка",
      ].join("\n")
    );
    return;
  }

  if (
    normalizedCommandText === "👤 вывод" ||
    normalizedCommandText === "👤 вывод собственника"
  ) {
    await sendMessage(
      chatId,
      [
        "Напишите вывод собственника обычным текстом.",
        "",
        "Пример:",
        "вывод 50000 продукты сбер",
      ].join("\n")
    );
    return;
  }

  if (
    normalizedCommandText === "🏦 кредит" ||
    normalizedCommandText === "🏦 кредит / займ"
  ) {
    await sendMessage(
      chatId,
      [
        "Напишите кредитную операцию обычным текстом.",
        "",
        "Примеры:",
        "тело кредит 17792 альфа",
        "проценты кредит 4229 альфа",
      ].join("\n")
    );
    return;
  }

  const pendingEdit = await findPendingEditDraft(chatId);

  if (pendingEdit) {
    await handlePendingTextEdit(
      message,
      pendingEdit.importSession.id,
      pendingEdit.draft
    );
    return;
  }

  const [companies, categories, accounts] = await Promise.all([
    prisma.company.findMany({
      where: {
        isActive: true,
      },
      orderBy: {
        name: "asc",
      },
      select: {
        name: true,
      },
    }),
    prisma.financeCategory.findMany({
      where: {
        isActive: true,
      },
      orderBy: [
        {
          categoryType: "asc",
        },
        {
          sortOrder: "asc",
        },
        {
          name: "asc",
        },
      ],
      select: {
        name: true,
        categoryType: true,
        profitTreatment: true,
      },
    }),
    prisma.financeAccount.findMany({
      where: {
        isActive: true,
      },
      orderBy: [
        {
          companyName: "asc",
        },
        {
          name: "asc",
        },
      ],
      select: {
        name: true,
        companyName: true,
      },
    }),
  ]);

  const parsed = parseTelegramFinanceMessage(text, {
    companies,
    categories,
    accounts,
  });

  if (!parsed.ok) {
    await sendMessage(
      chatId,
      [
        parsed.message,
        "",
        "Примеры:",
        ...parsed.examples.map((example) => `• ${example}`),
      ].join("\n")
    );
    return;
  }

  const draftJson: StoredDraftJson = {
    status: "PENDING",
    chatId,
    userId,
    rawText: text,
    operation: parsed.operation,
    pendingEdit: null,
  };

  const importSession = await prisma.importSession.create({
    data: {
      fileName: `telegram-${chatId}-${message.message_id}`,
      reportType: "TELEGRAM_FINANCE_DRAFT",
      marketplace: "FINANCE",
      companyName: parsed.operation.companyName,
      rowsCount: 1,
      previewJson: draftJson as unknown as Prisma.InputJsonValue,
      sheetName: "telegram",
      headerRow: 0,
      status: "PENDING",
    },
  });

  await sendMessage(
    chatId,
    formatDraftMessage(parsed.operation),
    confirmKeyboard(importSession.id)
  );
}

async function saveDraft(callbackQuery: TelegramCallbackQuery, draftId: string) {
  const message = callbackQuery.message;
  const chatId = message?.chat.id ? String(message.chat.id) : null;

  if (!chatId || !isChatAllowed(chatId)) {
    await answerCallbackQuery(callbackQuery.id, "Доступ запрещён");
    return;
  }

  const { importSession, draft } = await getDraft(draftId);

  if (!importSession || !draft) {
    await answerCallbackQuery(callbackQuery.id, "Черновик не найден");
    return;
  }

  if (importSession.status !== "PENDING") {
    await answerCallbackQuery(callbackQuery.id, "Черновик уже обработан");
    return;
  }

  const operation = draft.operation;

  await prisma.financeTransaction.create({
    data: {
      companyName: operation.companyName,
      operationDate: new Date(operation.operationDate),
      operationType: operation.operationType,
      category: operation.category,
      subcategory: null,
      counterparty: operation.counterparty,
      amount: operation.amount,
      bankAccount: operation.bankAccount,
      comment: operation.comment,
      project: operation.project,
      isInternalTransfer: operation.isInternalTransfer,
      sourceType: "TELEGRAM_BOT",
      sourceId: importSession.id,
    },
  });

  const updatedDraft: StoredDraftJson = {
    ...draft,
    status: "SUCCESS",
  };

  await prisma.importSession.update({
    where: {
      id: importSession.id,
    },
    data: {
      status: "SUCCESS",
      previewJson: updatedDraft as unknown as Prisma.InputJsonValue,
    },
  });

  await answerCallbackQuery(callbackQuery.id, "Сохранено");

  if (message?.message_id) {
    await editMessageText({
      chatId,
      messageId: message.message_id,
      text: formatSavedMessage(operation),
    });
  } else {
    await sendMessage(chatId, formatSavedMessage(operation));
  }
}

async function cancelDraft(callbackQuery: TelegramCallbackQuery, draftId: string) {
  const message = callbackQuery.message;
  const chatId = message?.chat.id ? String(message.chat.id) : null;

  if (!chatId || !isChatAllowed(chatId)) {
    await answerCallbackQuery(callbackQuery.id, "Доступ запрещён");
    return;
  }

  const { importSession, draft } = await getDraft(draftId);

  if (!importSession || !draft) {
    await answerCallbackQuery(callbackQuery.id, "Черновик не найден");
    return;
  }

  if (importSession.status !== "PENDING") {
    await answerCallbackQuery(callbackQuery.id, "Черновик уже обработан");
    return;
  }

  const updatedDraft: StoredDraftJson = {
    ...draft,
    status: "CANCELLED",
  };

  await prisma.importSession.update({
    where: {
      id: importSession.id,
    },
    data: {
      status: "CANCELLED",
      previewJson: updatedDraft as unknown as Prisma.InputJsonValue,
    },
  });

  await answerCallbackQuery(callbackQuery.id, "Отменено");

  if (message?.message_id) {
    await editMessageText({
      chatId,
      messageId: message.message_id,
      text: "❌ Операция отменена",
    });
  } else {
    await sendMessage(chatId, "❌ Операция отменена");
  }
}

async function showCompanyChoices(
  callbackQuery: TelegramCallbackQuery,
  draftId: string
) {
  const message = callbackQuery.message;
  const chatId = message?.chat.id ? String(message.chat.id) : null;

  if (!chatId || !message?.message_id) return;

  const companies = await prisma.company.findMany({
    where: {
      isActive: true,
    },
    orderBy: {
      name: "asc",
    },
    select: {
      id: true,
      name: true,
    },
  });

  await answerCallbackQuery(callbackQuery.id);

  await editMessageText({
    chatId,
    messageId: message.message_id,
    text: "Выберите компанию:",
    replyMarkup: {
      inline_keyboard: [
        ...companies.map((company) => [
          {
            text: company.name,
            callback_data: `set_company:${draftId}:${company.id}`,
          },
        ]),
        [
          {
            text: "← Назад",
            callback_data: `back:${draftId}`,
          },
        ],
      ],
    },
  });
}

async function showCategoryChoices(
  callbackQuery: TelegramCallbackQuery,
  draftId: string
) {
  const message = callbackQuery.message;
  const chatId = message?.chat.id ? String(message.chat.id) : null;

  if (!chatId || !message?.message_id) return;

  const { draft } = await getDraft(draftId);

  if (!draft) {
    await answerCallbackQuery(callbackQuery.id, "Черновик не найден");
    return;
  }

  const categories = await prisma.financeCategory.findMany({
    where: {
      isActive: true,
    },
    orderBy: [
      {
        sortOrder: "asc",
      },
      {
        name: "asc",
      },
    ],
    select: {
      id: true,
      name: true,
      categoryType: true,
    },
  });

  const filtered = categories.filter((category) => {
    return (
      CATEGORY_TYPE_TO_OPERATION_TYPE[category.categoryType] ===
      draft.operation.operationType
    );
  });

  const visible = (filtered.length > 0 ? filtered : categories).slice(0, 24);
  const rows = [];

  for (let index = 0; index < visible.length; index += 2) {
    rows.push(
      visible.slice(index, index + 2).map((category, innerIndex) => ({
        text: category.name.slice(0, 28),
        callback_data: `set_category_idx:${draftId}:${index + innerIndex}`,
      }))
    );
  }

  rows.push([
    {
      text: "← Назад",
      callback_data: `back:${draftId}`,
    },
  ]);

  await answerCallbackQuery(callbackQuery.id);

  await editMessageText({
    chatId,
    messageId: message.message_id,
    text: `Выберите статью для типа “${operationTypeLabel(
      draft.operation.operationType
    )}”:`,
    replyMarkup: {
      inline_keyboard: rows,
    },
  });
}

async function showAccountChoices(
  callbackQuery: TelegramCallbackQuery,
  draftId: string
) {
  const message = callbackQuery.message;
  const chatId = message?.chat.id ? String(message.chat.id) : null;

  if (!chatId || !message?.message_id) return;

  const { draft } = await getDraft(draftId);

  if (!draft) {
    await answerCallbackQuery(callbackQuery.id, "Черновик не найден");
    return;
  }

  const accounts = await prisma.financeAccount.findMany({
    where: {
      isActive: true,
      companyName: draft.operation.companyName,
    },
    orderBy: {
      name: "asc",
    },
    select: {
      id: true,
      name: true,
    },
  });

  const rows = accounts.map((account) => [
    {
      text: account.name,
      callback_data: `set_account:${draftId}:${account.id}`,
    },
  ]);

  rows.push([
    {
      text: "Без счёта",
      callback_data: `clear_account:${draftId}`,
    },
    {
      text: "← Назад",
      callback_data: `back:${draftId}`,
    },
  ]);

  await answerCallbackQuery(callbackQuery.id);

  await editMessageText({
    chatId,
    messageId: message.message_id,
    text: `Выберите счёт для ${draft.operation.companyName}:`,
    replyMarkup: {
      inline_keyboard: rows,
    },
  });
}

async function showAmountEditPrompt(
  callbackQuery: TelegramCallbackQuery,
  draftId: string
) {
  const message = callbackQuery.message;
  const chatId = message?.chat.id ? String(message.chat.id) : null;

  if (!chatId || !message?.message_id) return;

  const { draft } = await getDraft(draftId);

  if (!draft) {
    await answerCallbackQuery(callbackQuery.id, "Черновик не найден");
    return;
  }

  const updatedDraft: StoredDraftJson = {
    ...draft,
    pendingEdit: "AMOUNT",
  };

  await updateDraft(draftId, updatedDraft);
  await answerCallbackQuery(callbackQuery.id);

  await editMessageText({
    chatId,
    messageId: message.message_id,
    text: [
      "Введите новую сумму одним числом.",
      "",
      `Сейчас: ${formatMoney(draft.operation.amount)}`,
      "",
      "Пример: 15000",
    ].join("\n"),
    replyMarkup: {
      inline_keyboard: [
        [
          {
            text: "← Назад",
            callback_data: `back:${draftId}`,
          },
        ],
      ],
    },
  });
}

async function showCommentEditPrompt(
  callbackQuery: TelegramCallbackQuery,
  draftId: string
) {
  const message = callbackQuery.message;
  const chatId = message?.chat.id ? String(message.chat.id) : null;

  if (!chatId || !message?.message_id) return;

  const { draft } = await getDraft(draftId);

  if (!draft) {
    await answerCallbackQuery(callbackQuery.id, "Черновик не найден");
    return;
  }

  const updatedDraft: StoredDraftJson = {
    ...draft,
    pendingEdit: "COMMENT",
  };

  await updateDraft(draftId, updatedDraft);
  await answerCallbackQuery(callbackQuery.id);

  await editMessageText({
    chatId,
    messageId: message.message_id,
    text: [
      "Напишите новый комментарий.",
      "",
      "Чтобы убрать комментарий, отправьте: -",
      "",
      `Сейчас: ${draft.operation.comment ?? "—"}`,
    ].join("\n"),
    replyMarkup: {
      inline_keyboard: [
        [
          {
            text: "← Назад",
            callback_data: `back:${draftId}`,
          },
        ],
      ],
    },
  });
}

async function showDraftAgain(
  callbackQuery: TelegramCallbackQuery,
  draftId: string
) {
  const message = callbackQuery.message;
  const chatId = message?.chat.id ? String(message.chat.id) : null;

  if (!chatId || !message?.message_id) return;

  const { draft } = await getDraft(draftId);

  if (!draft) {
    await answerCallbackQuery(callbackQuery.id, "Черновик не найден");
    return;
  }

  const updatedDraft: StoredDraftJson = {
    ...draft,
    pendingEdit: null,
  };

  await updateDraft(draftId, updatedDraft);

  await answerCallbackQuery(callbackQuery.id);

  await editMessageText({
    chatId,
    messageId: message.message_id,
    text: formatDraftMessage(updatedDraft.operation),
    replyMarkup: confirmKeyboard(draftId),
  });
}

async function setCompany(
  callbackQuery: TelegramCallbackQuery,
  draftId: string,
  companyId: string
) {
  const message = callbackQuery.message;
  const chatId = message?.chat.id ? String(message.chat.id) : null;

  if (!chatId || !message?.message_id) return;

  const [{ draft }, company] = await Promise.all([
    getDraft(draftId),
    prisma.company.findUnique({
      where: {
        id: companyId,
      },
      select: {
        name: true,
      },
    }),
  ]);

  if (!draft || !company) {
    await answerCallbackQuery(callbackQuery.id, "Не найдено");
    return;
  }

  const account = await prisma.financeAccount.findFirst({
    where: {
      isActive: true,
      companyName: company.name,
    },
    orderBy: {
      name: "asc",
    },
  });

  const updatedDraft: StoredDraftJson = {
    ...draft,
    operation: {
      ...draft.operation,
      companyName: company.name,
      bankAccount: account?.name ?? null,
    },
  };

  await updateDraft(draftId, updatedDraft);
  await answerCallbackQuery(callbackQuery.id, "Компания изменена");

  await editMessageText({
    chatId,
    messageId: message.message_id,
    text: formatDraftMessage(updatedDraft.operation),
    replyMarkup: confirmKeyboard(draftId),
  });
}

async function setCategory(
  callbackQuery: TelegramCallbackQuery,
  draftId: string,
  categoryId: string
) {
  const message = callbackQuery.message;
  const chatId = message?.chat.id ? String(message.chat.id) : null;

  if (!chatId || !message?.message_id) return;

  const [{ draft }, category] = await Promise.all([
    getDraft(draftId),
    prisma.financeCategory.findUnique({
      where: {
        id: categoryId,
      },
      select: {
        name: true,
        categoryType: true,
      },
    }),
  ]);

  if (!draft || !category) {
    await answerCallbackQuery(callbackQuery.id, "Не найдено");
    return;
  }

  const operationType =
    CATEGORY_TYPE_TO_OPERATION_TYPE[category.categoryType] ??
    draft.operation.operationType;

  const updatedDraft: StoredDraftJson = {
    ...draft,
    operation: {
      ...draft.operation,
      operationType,
      category: category.name,
      isInternalTransfer:
        operationType === "TRANSFER" ||
        category.name.toLowerCase().includes("перевод"),
    },
  };

  await updateDraft(draftId, updatedDraft);
  await answerCallbackQuery(callbackQuery.id, "Статья изменена");

  await editMessageText({
    chatId,
    messageId: message.message_id,
    text: formatDraftMessage(updatedDraft.operation),
    replyMarkup: confirmKeyboard(draftId),
  });
}

async function setCategoryByIndex(
  callbackQuery: TelegramCallbackQuery,
  draftId: string,
  categoryIndex: string
) {
  const message = callbackQuery.message;
  const chatId = message?.chat.id ? String(message.chat.id) : null;

  if (!chatId || !message?.message_id) return;

  const { draft } = await getDraft(draftId);

  if (!draft) {
    await answerCallbackQuery(callbackQuery.id, "Черновик не найден");
    return;
  }

  const categories = await prisma.financeCategory.findMany({
    where: {
      isActive: true,
    },
    orderBy: [
      {
        sortOrder: "asc",
      },
      {
        name: "asc",
      },
    ],
    select: {
      name: true,
      categoryType: true,
    },
  });

  const filtered = categories.filter((category) => {
    return (
      CATEGORY_TYPE_TO_OPERATION_TYPE[category.categoryType] ===
      draft.operation.operationType
    );
  });

  const visible = (filtered.length > 0 ? filtered : categories).slice(0, 24);
  const index = Number(categoryIndex);
  const category = Number.isFinite(index) ? visible[index] : null;

  if (!category) {
    await answerCallbackQuery(callbackQuery.id, "Статья не найдена");
    return;
  }

  const operationType =
    CATEGORY_TYPE_TO_OPERATION_TYPE[category.categoryType] ??
    draft.operation.operationType;

  const updatedDraft: StoredDraftJson = {
    ...draft,
    operation: {
      ...draft.operation,
      operationType,
      category: category.name,
      isInternalTransfer:
        operationType === "TRANSFER" ||
        category.name.toLowerCase().includes("перевод"),
    },
  };

  await updateDraft(draftId, updatedDraft);
  await answerCallbackQuery(callbackQuery.id, "Статья изменена");

  await editMessageText({
    chatId,
    messageId: message.message_id,
    text: formatDraftMessage(updatedDraft.operation),
    replyMarkup: confirmKeyboard(draftId),
  });
}

async function setAccount(
  callbackQuery: TelegramCallbackQuery,
  draftId: string,
  accountId: string | null
) {
  const message = callbackQuery.message;
  const chatId = message?.chat.id ? String(message.chat.id) : null;

  if (!chatId || !message?.message_id) return;

  const { draft } = await getDraft(draftId);

  if (!draft) {
    await answerCallbackQuery(callbackQuery.id, "Черновик не найден");
    return;
  }

  const account = accountId
    ? await prisma.financeAccount.findUnique({
        where: {
          id: accountId,
        },
        select: {
          name: true,
        },
      })
    : null;

  const updatedDraft: StoredDraftJson = {
    ...draft,
    operation: {
      ...draft.operation,
      bankAccount: account?.name ?? null,
    },
  };

  await updateDraft(draftId, updatedDraft);
  await answerCallbackQuery(callbackQuery.id, "Счёт изменён");

  await editMessageText({
    chatId,
    messageId: message.message_id,
    text: formatDraftMessage(updatedDraft.operation),
    replyMarkup: confirmKeyboard(draftId),
  });
}

async function handleCallbackQuery(callbackQuery: TelegramCallbackQuery) {
  const data = callbackQuery.data ?? "";

  if (data === "quick_menu") {
    const message = callbackQuery.message;
    const chatId = message?.chat.id ? String(message.chat.id) : null;

    await answerCallbackQuery(callbackQuery.id);

    if (chatId) {
      await sendMessage(
        chatId,
        getVisualMenuMessage(chatId),
        visualMenuInlineKeyboard()
      );
    }

    return;
  }

  if (data === "report_menu") {
    const message = callbackQuery.message;
    const chatId = message?.chat.id ? String(message.chat.id) : null;

    await answerCallbackQuery(callbackQuery.id);

    if (chatId) {
      await sendReportMenu(chatId);
    }

    return;
  }

  if (data === "report_custom_help") {
    const message = callbackQuery.message;
    const chatId = message?.chat.id ? String(message.chat.id) : null;

    await answerCallbackQuery(callbackQuery.id);

    if (chatId) {
      await sendMessage(
        chatId,
        [
          "📅 Произвольный период",
          "",
          "Напишите даты одним сообщением:",
          "22.06.2026-28.06.2026",
          "или",
          "22.06.2026 28.06.2026",
          "",
          "Я построю отчёт и добавлю динамику к аналогичному предыдущему периоду.",
        ].join("\n")
      );
    }

    return;
  }

  if (data === "report_ai_menu") {
    const message = callbackQuery.message;
    const chatId = message?.chat.id ? String(message.chat.id) : null;

    await answerCallbackQuery(callbackQuery.id);

    if (chatId) {
      await sendAiReportMenu(chatId);
    }

    return;
  }

  if (data.startsWith("report_ai:")) {
    const message = callbackQuery.message;
    const chatId = message?.chat.id ? String(message.chat.id) : null;
    const preset = data.replace("report_ai:", "");

    await answerCallbackQuery(callbackQuery.id, "Готовлю AI-анализ");

    const allowedReportPresets = [
      "today",
      "yesterday",
      "current_week",
      "previous_week",
      "current_month",
      "previous_month",
      "last_30_days",
      "current_quarter",
      "ytd",
      // Старые значения оставляем для обратной совместимости.
      "day_before_yesterday",
      "3d",
      "7d",
      "15d",
      "month",
      "3m",
      "6m",
      "year",
      "30d",
      "90d",
      "365d",
    ] as const;

    if (chatId && allowedReportPresets.includes(preset as any)) {
      await sendDailyOwnerReport(
        chatId,
        preset as (typeof allowedReportPresets)[number],
        true
      );
    }

    return;
  }

  if (data.startsWith("report:")) {
    const message = callbackQuery.message;
    const chatId = message?.chat.id ? String(message.chat.id) : null;
    const preset = data.replace("report:", "");

    await answerCallbackQuery(callbackQuery.id, "Готовлю отчёт");

    const allowedReportPresets = [
      "today",
      "yesterday",
      "current_week",
      "previous_week",
      "current_month",
      "previous_month",
      "last_30_days",
      "current_quarter",
      "ytd",
      // Старые значения оставляем для обратной совместимости.
      "day_before_yesterday",
      "3d",
      "7d",
      "15d",
      "month",
      "3m",
      "6m",
      "year",
      "30d",
      "90d",
      "365d",
    ] as const;

    if (chatId && allowedReportPresets.includes(preset as any)) {
      await sendDailyOwnerReport(
        chatId,
        preset as (typeof allowedReportPresets)[number]
      );
    }

    return;
  }

  if (data.startsWith("quick_help:")) {
    const message = callbackQuery.message;
    const chatId = message?.chat.id ? String(message.chat.id) : null;
    const type = data.replace("quick_help:", "");

    await answerCallbackQuery(callbackQuery.id);

    if (chatId) {
      await sendMessage(chatId, getQuickHelpMessage(type), mainReplyKeyboard());
    }

    return;
  }

  if (data === "quick_last") {
    const message = callbackQuery.message;
    const chatId = message?.chat.id ? String(message.chat.id) : null;

    await answerCallbackQuery(callbackQuery.id);

    if (chatId) {
      await sendLastOperations(chatId);
    }

    return;
  }

  if (data === "quick_today") {
    const message = callbackQuery.message;
    const chatId = message?.chat.id ? String(message.chat.id) : null;

    await answerCallbackQuery(callbackQuery.id);

    if (chatId) {
      await sendTodayOperations(chatId);
    }

    return;
  }

  if (data === "quick_daily") {
    const message = callbackQuery.message;
    const chatId = message?.chat.id ? String(message.chat.id) : null;

    await answerCallbackQuery(callbackQuery.id);

    if (chatId) {
      await sendDailyOwnerReport(chatId);
    }

    return;
  }

  if (data === "quick_undo") {
    const message = callbackQuery.message;
    const chatId = message?.chat.id ? String(message.chat.id) : null;

    await answerCallbackQuery(callbackQuery.id);

    if (chatId) {
      await sendUndoLastOperationPrompt(chatId);
    }

    return;
  }

  if (data.startsWith("undo:")) {
    await undoSavedOperation(callbackQuery, data.replace("undo:", ""));
    return;
  }

  if (data === "undo_cancel") {
    await answerCallbackQuery(callbackQuery.id, "Оставлено");

    const message = callbackQuery.message;
    const chatId = message?.chat.id ? String(message.chat.id) : null;

    if (chatId && message?.message_id) {
      await editMessageText({
        chatId,
        messageId: message.message_id,
        text: "Операция оставлена без изменений",
      });
    }

    return;
  }

  if (data.startsWith("save:")) {
    await saveDraft(callbackQuery, data.replace("save:", ""));
    return;
  }

  if (data.startsWith("cancel:")) {
    await cancelDraft(callbackQuery, data.replace("cancel:", ""));
    return;
  }

  if (data.startsWith("edit_company:")) {
    await showCompanyChoices(callbackQuery, data.replace("edit_company:", ""));
    return;
  }

  if (data.startsWith("edit_category:")) {
    await showCategoryChoices(callbackQuery, data.replace("edit_category:", ""));
    return;
  }

  if (data.startsWith("edit_account:")) {
    await showAccountChoices(callbackQuery, data.replace("edit_account:", ""));
    return;
  }

  if (data.startsWith("edit_amount:")) {
    await showAmountEditPrompt(callbackQuery, data.replace("edit_amount:", ""));
    return;
  }

  if (data.startsWith("edit_comment:")) {
    await showCommentEditPrompt(
      callbackQuery,
      data.replace("edit_comment:", "")
    );
    return;
  }

  if (data.startsWith("back:")) {
    await showDraftAgain(callbackQuery, data.replace("back:", ""));
    return;
  }

  if (data.startsWith("set_company:")) {
    const [, draftId, companyId] = data.split(":");
    await setCompany(callbackQuery, draftId, companyId);
    return;
  }

  if (data.startsWith("set_category_idx:")) {
    const [, draftId, categoryIndex] = data.split(":");
    await setCategoryByIndex(callbackQuery, draftId, categoryIndex);
    return;
  }

  if (data.startsWith("set_category:")) {
    const [, draftId, categoryId] = data.split(":");
    await setCategory(callbackQuery, draftId, categoryId);
    return;
  }

  if (data.startsWith("set_account:")) {
    const [, draftId, accountId] = data.split(":");
    await setAccount(callbackQuery, draftId, accountId);
    return;
  }

  if (data.startsWith("clear_account:")) {
    await setAccount(callbackQuery, data.replace("clear_account:", ""), null);
    return;
  }

  await answerCallbackQuery(callbackQuery.id, "Неизвестная команда");
}

export async function POST(req: Request) {
  const webhookDenied = rejectUnauthorizedTelegramWebhook(req);
  if (webhookDenied) return webhookDenied;

  try {
    const update = (await req.json()) as TelegramUpdate;

    const directTelegramResponse = buildDirectTelegramWebhookResponse(update);

    if (directTelegramResponse) {
      return directTelegramResponse;
    }

    if (update.callback_query) {
      await handleCallbackQuery(update.callback_query);
      return NextResponse.json({ ok: true });
    }

    if (update.message) {
      await createDraftFromMessage(update.message);
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("TELEGRAM_WEBHOOK_ERROR", error);

    return NextResponse.json({ ok: true });
  }
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    name: "Marketplace OS Telegram webhook",
  });
}
