import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  parseTelegramFinanceMessage,
  type ParsedFinanceOperation,
} from "@/lib/telegram/financeBotParser";

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
  ]
    .filter((line) => line !== null)
    .join("\n");
}

function getHelpMessage(chatId: string) {
  return [
    "Я помогу быстро добавлять финансовые операции.",
    "",
    "Пишите обычным текстом:",
    "",
    "• закуп 15000 петров сбер упаковка",
    "• поступило 4881996 лебедева ozon выручка",
    "• вывод 50000 продукты сбер",
    "• тело кредит 17792 альфа",
    "• интернет 1700",
    "",
    "Я разберу сообщение и покажу подтверждение перед сохранением.",
    "",
    `Ваш chat id: ${chatId}`,
  ].join("\n");
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
}) {
  return telegramRequest("editMessageText", {
    chat_id: params.chatId,
    message_id: params.messageId,
    text: params.text,
    disable_web_page_preview: true,
    reply_markup: {
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

  if (text.startsWith("/start") || text.startsWith("/help")) {
    await sendMessage(chatId, getHelpMessage(chatId));
    return;
  }

  if (text.startsWith("/id")) {
    await sendMessage(chatId, `Ваш chat id: ${chatId}`);
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

  const importSession = await prisma.importSession.create({
    data: {
      fileName: `telegram-${chatId}-${message.message_id}`,
      reportType: "TELEGRAM_FINANCE_DRAFT",
      marketplace: "FINANCE",
      companyName: parsed.operation.companyName,
      rowsCount: 1,
      previewJson: {
        status: "PENDING",
        chatId,
        userId,
        rawText: text,
        operation: parsed.operation,
      } satisfies Prisma.InputJsonValue,
      sheetName: "telegram",
      headerRow: 0,
      status: "PENDING",
    },
  });

  await sendMessage(chatId, formatDraftMessage(parsed.operation), {
    inline_keyboard: [
      [
        {
          text: "✅ Сохранить",
          callback_data: `save:${importSession.id}`,
        },
        {
          text: "❌ Отмена",
          callback_data: `cancel:${importSession.id}`,
        },
      ],
    ],
  });
}

async function saveDraft(callbackQuery: TelegramCallbackQuery, draftId: string) {
  const message = callbackQuery.message;
  const chatId = message?.chat.id ? String(message.chat.id) : null;

  if (!chatId || !isChatAllowed(chatId)) {
    await answerCallbackQuery(callbackQuery.id, "Доступ запрещён");
    return;
  }

  const importSession = await prisma.importSession.findUnique({
    where: {
      id: draftId,
    },
  });

  const draft = importSession?.previewJson
    ? asStoredDraftJson(importSession.previewJson)
    : null;

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

  await prisma.importSession.update({
    where: {
      id: importSession.id,
    },
    data: {
      status: "SUCCESS",
      previewJson: {
        ...draft,
        status: "SUCCESS",
      } satisfies Prisma.InputJsonValue,
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

  const importSession = await prisma.importSession.findUnique({
    where: {
      id: draftId,
    },
  });

  const draft = importSession?.previewJson
    ? asStoredDraftJson(importSession.previewJson)
    : null;

  if (!importSession || !draft) {
    await answerCallbackQuery(callbackQuery.id, "Черновик не найден");
    return;
  }

  if (importSession.status !== "PENDING") {
    await answerCallbackQuery(callbackQuery.id, "Черновик уже обработан");
    return;
  }

  await prisma.importSession.update({
    where: {
      id: importSession.id,
    },
    data: {
      status: "CANCELLED",
      previewJson: {
        ...draft,
        status: "CANCELLED",
      } satisfies Prisma.InputJsonValue,
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

async function handleCallbackQuery(callbackQuery: TelegramCallbackQuery) {
  const data = callbackQuery.data ?? "";

  if (data.startsWith("save:")) {
    await saveDraft(callbackQuery, data.replace("save:", ""));
    return;
  }

  if (data.startsWith("cancel:")) {
    await cancelDraft(callbackQuery, data.replace("cancel:", ""));
    return;
  }

  await answerCallbackQuery(callbackQuery.id, "Неизвестная команда");
}

export async function POST(req: Request) {
  const configuredSecret = getWebhookSecret();
  const incomingSecret = req.headers.get("x-telegram-bot-api-secret-token");

  if (configuredSecret && incomingSecret !== configuredSecret) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  try {
    const update = (await req.json()) as TelegramUpdate;

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
