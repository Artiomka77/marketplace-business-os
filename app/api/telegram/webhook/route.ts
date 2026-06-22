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
