import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  evaluateOwnerReportCogsCoverage,
} from "@/lib/telegram/ownerReportCogsCoverage";
import {
  enrichMissingCogsItemsForDisplay,
  formatMissingItemCaption,
  listUnresolvedCogsItems,
  parseOwnerCostInput,
  resolveMissingCogsProductCostVendor,
  type MissingCogsListItem,
} from "@/lib/telegram/ownerReportMissingCogs";
import { moscowBusinessYesterday } from "@/lib/telegram/ozonMorningReportGate";
import {
  findStaticProductCostByVendor,
  upsertStaticProductCostFromOwner,
} from "@/lib/productCost/upsertStaticProductCost";
import {
  sendTelegramMessage,
  sendTelegramPhoto,
} from "@/lib/telegram/sendTelegramMessage";
import { normalizeProductCostVendor } from "@/lib/productCost/staticProductCost";

export const TELEGRAM_PCOST_FLOW_REPORT_TYPE = "TELEGRAM_PRODUCT_COST_FLOW";

type FlowStep =
  | "LIST"
  | "AWAITING_COST"
  | "CONFIRM_CREATE"
  | "CONFIRM_UPDATE"
  | "SEARCH";

type FlowState = {
  chatId: string;
  actorUserId: string | null;
  businessDate: string;
  step: FlowStep;
  items: MissingCogsListItem[];
  selectedKey: string | null;
  pendingCost: number | null;
  searchQuery: string | null;
};

function moneyRu(n: number) {
  return new Intl.NumberFormat("ru-RU", {
    maximumFractionDigits: 2,
  }).format(n);
}

async function loadFlow(chatId: string): Promise<{
  sessionId: string | null;
  state: FlowState | null;
}> {
  const row = await prisma.importSession.findFirst({
    where: {
      reportType: TELEGRAM_PCOST_FLOW_REPORT_TYPE,
      companyName: chatId,
      status: "PENDING",
    },
    orderBy: { createdAt: "desc" },
  });
  if (!row?.previewJson || typeof row.previewJson !== "object") {
    return { sessionId: row?.id ?? null, state: null };
  }
  return {
    sessionId: row.id,
    state: row.previewJson as FlowState,
  };
}

async function saveFlow(chatId: string, state: FlowState, sessionId?: string | null) {
  const data = {
    reportType: TELEGRAM_PCOST_FLOW_REPORT_TYPE,
    marketplace: "TELEGRAM",
    companyName: chatId,
    rowsCount: state.items.length,
    fileName: `pcost-flow:${chatId}`,
    status: "PENDING",
    previewJson: state as unknown as Prisma.InputJsonValue,
  };
  if (sessionId) {
    await prisma.importSession.update({ where: { id: sessionId }, data });
    return sessionId;
  }
  const created = await prisma.importSession.create({ data });
  return created.id;
}

async function closeFlow(sessionId: string | null) {
  if (!sessionId) return;
  await prisma.importSession.update({
    where: { id: sessionId },
    data: { status: "SUCCESS" },
  });
}

function selectedItem(state: FlowState): MissingCogsListItem | null {
  if (!state.selectedKey) return null;
  return state.items.find((i) => i.key === state.selectedKey) ?? null;
}

function listKeyboard(state: FlowState) {
  const rows = state.items.slice(0, 8).map((item, idx) => {
    const label = item.humanArticle || item.article;
    const size = item.size ? ` р.${item.size}` : "";
    return [
      {
        text: `${label}${size} · ${item.marketplace} · ${Math.round(item.qty)} шт`.slice(
          0,
          64,
        ),
        callback_data: `pcost:i:${idx}`,
      },
    ];
  });
  rows.push([
    { text: "🔎 Найти SKU / артикул", callback_data: "pcost:search" },
  ]);
  rows.push([{ text: "❌ Закрыть", callback_data: "pcost:cancel" }]);
  return { inline_keyboard: rows };
}

export async function openMissingCostMenu(params: {
  chatId: string;
  actorUserId?: string | null;
  businessDate?: string | null;
  send: (text: string, replyMarkup?: Record<string, unknown>) => Promise<unknown>;
}) {
  const businessDate =
    params.businessDate && /^\d{4}-\d{2}-\d{2}$/.test(params.businessDate)
      ? params.businessDate
      : moscowBusinessYesterday();
  const cogs = await evaluateOwnerReportCogsCoverage(businessDate);
  const items = await enrichMissingCogsItemsForDisplay(
    listUnresolvedCogsItems(cogs),
  );
  const state: FlowState = {
    chatId: params.chatId,
    actorUserId: params.actorUserId ?? null,
    businessDate,
    step: "LIST",
    items,
    selectedKey: null,
    pendingCost: null,
    searchQuery: null,
  };
  const existing = await loadFlow(params.chatId);
  await saveFlow(params.chatId, state, existing.sessionId);

  if (items.length === 0) {
    await params.send(
      `✅ За ${businessDate.split("-").reverse().join(".")} все SKU с себестоимостью покрыты.`,
    );
    return { ok: true, empty: true };
  }

  await params.send(
    [
      `SKU без себестоимости · ${businessDate.split("-").reverse().join(".")}`,
      `${items.length} поз. / ${Math.round(cogs.unresolvedQty)} шт`,
      "",
      "Выберите позицию:",
    ].join("\n"),
    listKeyboard(state),
  );
  return { ok: true, empty: false, count: items.length };
}

async function showSelectedItem(params: {
  state: FlowState;
  sessionId: string;
  send: (text: string, replyMarkup?: Record<string, unknown>) => Promise<unknown>;
}) {
  const item = selectedItem(params.state);
  if (!item) {
    await params.send("Позиция не найдена.");
    return;
  }
  const vendor = resolveMissingCogsProductCostVendor(item);
  const existing = await findStaticProductCostByVendor(vendor);
  const caption = formatMissingItemCaption(item);
  const identity = [
    caption,
    `Ключ ProductCost: ${normalizeProductCostVendor(vendor)}`,
  ].join("\n");

  if (existing?.costPrice != null) {
    params.state.step = "LIST";
    await saveFlow(params.state.chatId, params.state, params.sessionId);
    const replyMarkup = {
      inline_keyboard: [
        [{ text: "✏️ Изменить", callback_data: `pcost:edit` }],
        [
          {
            text: "← К списку",
            callback_data: `pcost:open:${params.state.businessDate}`,
          },
        ],
      ],
    };
    const text = [
      identity,
      "",
      `Текущая себестоимость: ${moneyRu(existing.costPrice)} ₽/шт`,
    ].join("\n");
    if (item.imageUrl) {
      const photo = await sendTelegramPhoto({
        chatId: params.state.chatId,
        photoUrl: item.imageUrl,
        caption: text.slice(0, 1024),
        replyMarkup,
      });
      if (photo) return;
    }
    await params.send(text, replyMarkup);
    return;
  }

  params.state.step = "AWAITING_COST";
  await saveFlow(params.state.chatId, params.state, params.sessionId);
  const replyMarkup = {
    inline_keyboard: [[{ text: "❌ Отмена", callback_data: "pcost:cancel" }]],
  };
  const prompt = [
    identity,
    "",
    "Введите себестоимость за 1 шт. в рублях",
    "Пример: 1450 или 1450,50",
  ].join("\n");
  if (item.imageUrl) {
    const photo = await sendTelegramPhoto({
      chatId: params.state.chatId,
      photoUrl: item.imageUrl,
      caption: prompt.slice(0, 1024),
      replyMarkup,
    });
    if (photo) return;
  }
  await params.send(prompt, replyMarkup);
}

export async function handleProductCostCallback(params: {
  chatId: string;
  actorUserId?: string | null;
  data: string;
  answer: (text?: string) => Promise<unknown>;
  send: (text: string, replyMarkup?: Record<string, unknown>) => Promise<unknown>;
  onAfterSave?: (businessDate: string) => Promise<void>;
}): Promise<boolean> {
  if (!params.data.startsWith("pcost:")) return false;

  await params.answer();

  if (params.data === "pcost:cancel") {
    const { sessionId } = await loadFlow(params.chatId);
    await closeFlow(sessionId);
    await params.send("Добавление себестоимости отменено.");
    return true;
  }

  if (params.data.startsWith("pcost:open:")) {
    const date = params.data.slice("pcost:open:".length);
    await openMissingCostMenu({
      chatId: params.chatId,
      actorUserId: params.actorUserId,
      businessDate: date,
      send: params.send,
    });
    return true;
  }

  if (params.data === "pcost:menu" || params.data === "pcost:open") {
    await openMissingCostMenu({
      chatId: params.chatId,
      actorUserId: params.actorUserId,
      send: params.send,
    });
    return true;
  }

  const loaded = await loadFlow(params.chatId);
  if (!loaded.state || !loaded.sessionId) {
    await openMissingCostMenu({
      chatId: params.chatId,
      actorUserId: params.actorUserId,
      send: params.send,
    });
    return true;
  }
  const state = loaded.state;

  if (params.data === "pcost:search") {
    state.step = "SEARCH";
    await saveFlow(params.chatId, state, loaded.sessionId);
    await params.send("Введите артикул или SKU для поиска:");
    return true;
  }

  if (params.data.startsWith("pcost:i:")) {
    const idx = Number(params.data.slice("pcost:i:".length));
    const item = state.items[idx];
    if (!item) {
      await params.send("Позиция устарела. Откройте список снова.");
      return true;
    }
    state.selectedKey = item.key;
    state.pendingCost = null;
    await saveFlow(params.chatId, state, loaded.sessionId);
    await showSelectedItem({ state, sessionId: loaded.sessionId, send: params.send });
    return true;
  }

  if (params.data === "pcost:edit") {
    const item = selectedItem(state);
    if (!item) {
      await params.send("Сначала выберите SKU.");
      return true;
    }
    state.step = "AWAITING_COST";
    await saveFlow(params.chatId, state, loaded.sessionId);
    await params.send("Введите новую себестоимость за 1 шт. в рублях:");
    return true;
  }

  if (params.data === "pcost:no") {
    state.step = "AWAITING_COST";
    state.pendingCost = null;
    await saveFlow(params.chatId, state, loaded.sessionId);
    await params.send("Отменено. Введите себестоимость заново или выберите другую позицию.");
    return true;
  }

  if (params.data === "pcost:ok") {
    const item = selectedItem(state);
    const cost = state.pendingCost;
    if (!item || cost == null) {
      await params.send("Нет данных для сохранения.");
      return true;
    }
    const vendor = resolveMissingCogsProductCostVendor(item);
    if (!normalizeProductCostVendor(vendor)) {
      await params.send(
        "Не удалось однозначно определить товар. Добавление отменено.",
      );
      return true;
    }
    const result = await upsertStaticProductCostFromOwner({
      vendorCode: vendor,
      costPrice: cost,
      nmId: item.nmId,
      name: item.article,
      actorChatId: params.chatId,
      actorUserId: params.actorUserId,
      presentedArticle: item.article,
      presentedSku: item.skuId,
      marketplace: item.marketplace,
      confirmationReceived: true,
    });
    if (!result.ok) {
      await params.send(
        result.reason === "AMBIGUOUS_OR_EMPTY_VENDOR"
          ? "Не удалось однозначно определить товар. Добавление отменено."
          : `Ошибка сохранения: ${result.reason}`,
      );
      return true;
    }
    await closeFlow(loaded.sessionId);
    await params.send(
      `✅ Себестоимость сохранена: ${item.article} — ${moneyRu(cost)} ₽/шт`,
    );
    if (params.onAfterSave) {
      await params.onAfterSave(state.businessDate);
    }
    return true;
  }

  return true;
}

export async function handleProductCostTextInput(params: {
  chatId: string;
  actorUserId?: string | null;
  text: string;
  send: (text: string, replyMarkup?: Record<string, unknown>) => Promise<unknown>;
}): Promise<boolean> {
  const loaded = await loadFlow(params.chatId);
  if (!loaded.state || !loaded.sessionId) return false;
  const state = loaded.state;

  if (state.step === "SEARCH") {
    const q = normalizeProductCostVendor(params.text);
    const hits = state.items.filter((i) => {
      const hay = normalizeProductCostVendor(
        `${i.article} ${i.skuId ?? ""} ${i.vendorCode ?? ""} ${i.nmId ?? ""}`,
      );
      return hay.includes(q);
    });
    if (hits.length === 0) {
      await params.send("Ничего не найдено среди SKU без себестоимости.");
      return true;
    }
    state.items = hits;
    state.step = "LIST";
    await saveFlow(params.chatId, state, loaded.sessionId);
    await params.send(`Найдено: ${hits.length}`, listKeyboard(state));
    return true;
  }

  if (state.step !== "AWAITING_COST") return false;

  const parsed = parseOwnerCostInput(params.text);
  if (!parsed.ok) {
    await params.send(
      "Некорректная сумма. Введите число > 0, например 1450 или 1450,50",
    );
    return true;
  }

  const item = selectedItem(state);
  if (!item) {
    await params.send("Сначала выберите SKU.");
    return true;
  }

  const vendor = resolveMissingCogsProductCostVendor(item);
  const existing = await findStaticProductCostByVendor(vendor);
  state.pendingCost = parsed.value;
  state.step = existing?.costPrice != null ? "CONFIRM_UPDATE" : "CONFIRM_CREATE";
  await saveFlow(params.chatId, state, loaded.sessionId);

  if (existing?.costPrice != null) {
    await params.send(
      [
        `Изменить себестоимость для ${item.article}?`,
        `Было: ${moneyRu(existing.costPrice)} ₽/шт`,
        `Станет: ${moneyRu(parsed.value)} ₽/шт`,
      ].join("\n"),
      {
        inline_keyboard: [
          [
            { text: "✅ Подтвердить", callback_data: "pcost:ok" },
            { text: "❌ Отмена", callback_data: "pcost:no" },
          ],
        ],
      },
    );
  } else {
    await params.send(
      `Установить себестоимость ${moneyRu(parsed.value)} ₽/шт для ${item.article}?`,
      {
        inline_keyboard: [
          [
            { text: "✅ Подтвердить", callback_data: "pcost:ok" },
            { text: "❌ Отмена", callback_data: "pcost:no" },
          ],
        ],
      },
    );
  }
  return true;
}

export async function notifyOwnerCogsReminder(params: {
  businessDate: string;
  unresolvedSkuCount: number;
}) {
  const { getTelegramAllowedChatIds } = await import(
    "@/lib/telegram/sendTelegramMessage"
  );
  const chatIds = getTelegramAllowedChatIds();
  const [y, m, d] = params.businessDate.split("-");
  const text = `⚠️ Для финальной прибыли не хватает себестоимости по ${params.unresolvedSkuCount} SKU (${d}.${m}.${y}).`;
  for (const chatId of chatIds) {
    await sendTelegramMessage({
      chatId,
      text,
      replyMarkup: {
        inline_keyboard: [
          [
            {
              text: "➕ Добавить себестоимость",
              callback_data: `pcost:open:${params.businessDate}`,
            },
          ],
        ],
      },
    });
  }
}
