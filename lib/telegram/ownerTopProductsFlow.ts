/**
 * Owner Telegram UX: TOP products by orders / profit / margin / losses.
 * Reuses canonical Profit WB/Ozon SKU analytics — no second calculator.
 */
import { Prisma } from "@prisma/client";

import { getProfitAnalytics } from "@/lib/analytics/profitAnalytics";
import { getProfitAnalyticsOzon } from "@/lib/analytics/profitAnalyticsOzon";
import { prisma } from "@/lib/prisma";
import {
  formatCompactMoney,
  formatCompactSignedMoney,
} from "@/lib/telegram/dailyReport";
import { loadCompleteOrderUniverse } from "@/lib/telegram/ownerTopOrderUniverse";
import {
  derivedMarginPct,
  sortOrderUniverse,
  type OrderUniverseRow,
} from "@/lib/telegram/ownerTopOrderRankMath";
import { resolveOzonHumanIdentity } from "@/lib/telegram/ownerReportV3Loaders";
import { moscowBusinessYesterday } from "@/lib/telegram/ozonMorningReportGate";
import { sendTelegramPhoto } from "@/lib/telegram/sendTelegramMessage";

export const TELEGRAM_TOP_FLOW_REPORT_TYPE = "TELEGRAM_OWNER_TOP_FLOW";

export type TopPeriodKey =
  | "today"
  | "yesterday"
  | "7d"
  | "30d"
  | "current_week"
  | "previous_week"
  | "current_month"
  | "previous_month"
  | "custom";

export type TopScopeKey = "all" | "pw" | "po" | "lw" | "lo";

export type TopCriterionKey = "amt" | "qty" | "prf" | "mrg" | "loss";

export type TopLimitKey = 3 | 5 | 10;

type TopFlowState = {
  chatId: string;
  period: TopPeriodKey;
  customFrom: string | null;
  customTo: string | null;
  scope: TopScopeKey;
  criterion: TopCriterionKey;
  limit: TopLimitKey;
  customStep: "NONE" | "FROM" | "TO";
  lastItems: TopRankItem[];
  statusLabel: "FINAL" | "PRELIMINARY";
  excludedIncomplete: number;
  allocatedFooter: boolean;
};

export type TopRankItem = {
  key: string;
  label: string;
  companyName: string;
  marketplace: "WB" | "OZON" | "ALL";
  qty: number;
  ordersAmount: number;
  profit: number | null;
  marginPct: number | null;
  turnover: number | null;
  imageUrl: string | null;
  sku: string | null;
  cogsComplete: boolean;
};

function money(n: number) {
  return formatCompactMoney(n);
}

function moneySigned(n: number) {
  return formatCompactSignedMoney(n);
}

function pct(n: number | null) {
  if (n == null || !Number.isFinite(n)) return "н/д";
  return `${n.toFixed(1).replace(".", ",")}%`;
}

function mskParts(now = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const [y, m, d] = fmt.format(now).split("-").map(Number);
  return { y, m, d };
}

function isoFromParts(y: number, m: number, d: number) {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function addDaysIso(iso: string, days: number) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

function startOfWeekMonday(iso: string) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = dt.getUTCDay(); // 0 Sun
  const offset = dow === 0 ? -6 : 1 - dow;
  return addDaysIso(iso, offset);
}

export function resolveTopPeriodRange(
  period: TopPeriodKey,
  customFrom: string | null,
  customTo: string | null,
  now = new Date(),
): { from: string; to: string; label: string } {
  const { y, m, d } = mskParts(now);
  const today = isoFromParts(y, m, d);
  const yesterday = addDaysIso(today, -1);

  if (period === "today") return { from: today, to: today, label: formatRuRange(today, today) };
  if (period === "yesterday")
    return { from: yesterday, to: yesterday, label: formatRuRange(yesterday, yesterday) };
  if (period === "7d") {
    const from = addDaysIso(today, -6);
    return { from, to: today, label: formatRuRange(from, today) };
  }
  if (period === "30d") {
    const from = addDaysIso(today, -29);
    return { from, to: today, label: formatRuRange(from, today) };
  }
  if (period === "current_week") {
    const from = startOfWeekMonday(today);
    return { from, to: today, label: formatRuRange(from, today) };
  }
  if (period === "previous_week") {
    const thisMon = startOfWeekMonday(today);
    const from = addDaysIso(thisMon, -7);
    const to = addDaysIso(thisMon, -1);
    return { from, to, label: formatRuRange(from, to) };
  }
  if (period === "current_month") {
    const from = isoFromParts(y, m, 1);
    return { from, to: today, label: formatRuRange(from, today) };
  }
  if (period === "previous_month") {
    const firstThis = isoFromParts(y, m, 1);
    const to = addDaysIso(firstThis, -1);
    const [ty, tm] = to.split("-").map(Number);
    const from = isoFromParts(ty, tm, 1);
    return { from, to, label: formatRuRange(from, to) };
  }
  if (period === "custom" && customFrom && customTo) {
    return {
      from: customFrom,
      to: customTo,
      label: formatRuRange(customFrom, customTo),
    };
  }
  return {
    from: yesterday,
    to: yesterday,
    label: formatRuRange(yesterday, yesterday),
  };
}

function formatRuRange(from: string, to: string) {
  const fr = from.split("-").reverse().join(".").slice(0, 5);
  const tr = to.split("-").reverse().join(".").slice(0, 5);
  if (from === to) return fr;
  return `${fr}–${tr}`;
}

function scopeMeta(scope: TopScopeKey): {
  title: string;
  companyName: string | null;
  marketplace: "WB" | "OZON" | null;
} {
  switch (scope) {
    case "pw":
      return { title: "Петров · WB", companyName: "ИП Петров", marketplace: "WB" };
    case "po":
      return { title: "Петров · Ozon", companyName: "ИП Петров", marketplace: "OZON" };
    case "lw":
      return { title: "Лебедева · WB", companyName: "ИП Лебедева", marketplace: "WB" };
    case "lo":
      return { title: "Лебедева · Ozon", companyName: "ИП Лебедева", marketplace: "OZON" };
    default:
      return { title: "Весь бизнес", companyName: null, marketplace: null };
  }
}

function criterionLabel(c: TopCriterionKey) {
  switch (c) {
    case "amt":
      return "по сумме заказов";
    case "qty":
      return "по штукам";
    case "prf":
      return "по прибыли";
    case "mrg":
      return "по марже";
    case "loss":
      return "убыточные";
  }
}

async function loadFlow(chatId: string): Promise<{
  sessionId: string | null;
  state: TopFlowState | null;
}> {
  const row = await prisma.importSession.findFirst({
    where: {
      reportType: TELEGRAM_TOP_FLOW_REPORT_TYPE,
      companyName: chatId,
      status: "PENDING",
    },
    orderBy: { createdAt: "desc" },
  });
  if (!row?.previewJson || typeof row.previewJson !== "object") {
    return { sessionId: row?.id ?? null, state: null };
  }
  return { sessionId: row.id, state: row.previewJson as TopFlowState };
}

async function saveFlow(chatId: string, state: TopFlowState, sessionId?: string | null) {
  const data = {
    reportType: TELEGRAM_TOP_FLOW_REPORT_TYPE,
    marketplace: "TELEGRAM",
    companyName: chatId,
    rowsCount: state.lastItems.length,
    fileName: `top-flow:${chatId}`,
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

function defaultState(chatId: string, seedDate?: string | null): TopFlowState {
  const yesterday = moscowBusinessYesterday();
  const period: TopPeriodKey =
    seedDate && /^\d{4}-\d{2}-\d{2}$/.test(seedDate) && seedDate === yesterday
      ? "yesterday"
      : seedDate && /^\d{4}-\d{2}-\d{2}$/.test(seedDate)
        ? "custom"
        : "yesterday";
  return {
    chatId,
    period,
    customFrom: period === "custom" ? seedDate! : null,
    customTo: period === "custom" ? seedDate! : null,
    scope: "all",
    criterion: "amt",
    limit: 5,
    customStep: "NONE",
    lastItems: [],
    statusLabel: "FINAL",
    excludedIncomplete: 0,
    allocatedFooter: false,
  };
}

export function topPeriodKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "Сегодня", callback_data: "top:per:today" },
        { text: "Вчера", callback_data: "top:per:yesterday" },
      ],
      [
        { text: "7 дней", callback_data: "top:per:7d" },
        { text: "30 дней", callback_data: "top:per:30d" },
      ],
      [
        { text: "Текущая неделя", callback_data: "top:per:current_week" },
        { text: "Прошлая неделя", callback_data: "top:per:previous_week" },
      ],
      [
        { text: "Текущий месяц", callback_data: "top:per:current_month" },
        { text: "Прошлый месяц", callback_data: "top:per:previous_month" },
      ],
      [{ text: "📅 Выбрать период", callback_data: "top:per:custom" }],
      [{ text: "← Назад", callback_data: "top:nav:menu" }],
    ],
  };
}

export function topScopeKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "🏢 Весь бизнес", callback_data: "top:scp:all" }],
      [
        { text: "🟣 Петров · WB", callback_data: "top:scp:pw" },
        { text: "🔵 Петров · Ozon", callback_data: "top:scp:po" },
      ],
      [
        { text: "🟣 Лебедева · WB", callback_data: "top:scp:lw" },
        { text: "🔵 Лебедева · Ozon", callback_data: "top:scp:lo" },
      ],
      [{ text: "← Период", callback_data: "top:nav:per" }],
    ],
  };
}

export function topCriterionKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "💳 По сумме заказов", callback_data: "top:crit:amt" }],
      [{ text: "🛒 По штукам", callback_data: "top:crit:qty" }],
      [{ text: "💰 По прибыли", callback_data: "top:crit:prf" }],
      [{ text: "📊 По марже", callback_data: "top:crit:mrg" }],
      [{ text: "🔻 Убыточные", callback_data: "top:crit:loss" }],
      [{ text: "← Кабинет", callback_data: "top:nav:scp" }],
    ],
  };
}

export function topLimitKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "TOP-3", callback_data: "top:lim:3" },
        { text: "TOP-5", callback_data: "top:lim:5" },
        { text: "TOP-10", callback_data: "top:lim:10" },
      ],
      [{ text: "← Критерий", callback_data: "top:nav:crit" }],
    ],
  };
}

function resultNavKeyboard(state: TopFlowState) {
  return {
    inline_keyboard: [
      [
        { text: "TOP-3", callback_data: "top:lim:3" },
        { text: "TOP-5", callback_data: "top:lim:5" },
        { text: "TOP-10", callback_data: "top:lim:10" },
      ],
      [
        { text: "💳 Сумма", callback_data: "top:crit:amt" },
        { text: "🛒 Штуки", callback_data: "top:crit:qty" },
      ],
      [
        { text: "💰 Прибыль", callback_data: "top:crit:prf" },
        { text: "📊 Маржа", callback_data: "top:crit:mrg" },
      ],
      [{ text: "🔻 Убытки", callback_data: "top:crit:loss" }],
      [
        { text: "🏢 Кабинет", callback_data: "top:nav:scp" },
        { text: "📅 Период", callback_data: "top:nav:per" },
      ],
      [{ text: "🏠 Меню", callback_data: "top:nav:menu" }],
      ...state.lastItems.slice(0, Math.min(state.limit, 8)).map((_, i) => [
        {
          text: `${i + 1}. подробнее`,
          callback_data: `top:item:${i}`,
        },
      ]),
    ],
  };
}

type ProfitAgg = {
  key: string;
  /** Exact canonical family for ALL merge; null → never merge by display label. */
  exactFamilyKey: string | null;
  label: string;
  companyName: string;
  marketplace: "WB" | "OZON" | "ALL";
  profit: number;
  marginPct: number | null;
  turnover: number;
  qty: number;
  sku: string | null;
  imageUrl: string | null;
  cogsComplete: boolean;
  hasAllocated: boolean;
};

async function loadProfitRanks(params: {
  from: string;
  to: string;
  companyName: string | null;
  marketplace: "WB" | "OZON" | null;
}): Promise<{ items: ProfitAgg[]; excludedIncomplete: number; allocatedFooter: boolean }> {
  const cabinets: Array<{ companyName: string; marketplace: "WB" | "OZON" }> = [];
  const companies = params.companyName
    ? [params.companyName]
    : ["ИП Петров", "ИП Лебедева"];
  for (const c of companies) {
    for (const mp of ["WB", "OZON"] as const) {
      if (params.marketplace && params.marketplace !== mp) continue;
      cabinets.push({ companyName: c, marketplace: mp });
    }
  }

  /** All rows including incomplete — needed for fail-closed ALL family merge. */
  const rawItems: ProfitAgg[] = [];
  let allocatedFooter = false;

  for (const cab of cabinets) {
    if (cab.marketplace === "WB") {
      const analytics = await getProfitAnalytics({
        companyName: cab.companyName,
        dateFrom: params.from,
        dateTo: params.to,
      });
      for (const row of analytics.rows ?? []) {
        const incomplete =
          Number(row.costPrice ?? 0) <= 0 && Math.abs(Number(row.netSalesQty ?? 0)) > 0.0001;
        const profit = Number(row.netProfitAfterTax ?? 0);
        const turnover = Number(row.revenue ?? 0);
        const vendor = String(row.vendorCode ?? "").trim();
        const nmId = String(row.nmId ?? "").trim();
        const card = nmId
          ? await prisma.wbProductCard.findFirst({
              where: { companyName: cab.companyName, nmId },
              select: { photoSmallUrl: true, photoBigUrl: true, vendorCode: true },
            })
          : null;
        const label = card?.vendorCode?.trim() || vendor || nmId || "UNKNOWN";
        const exactFamily =
          label && !/^\d{6,}$/.test(label) ? label.trim().toUpperCase() : null;
        rawItems.push({
          key: `WB|${cab.companyName}|${nmId || label.toUpperCase()}`,
          exactFamilyKey: exactFamily,
          label,
          companyName: cab.companyName,
          marketplace: "WB",
          profit,
          marginPct: incomplete
            ? null
            : Number(row.marginProfitPercent ?? derivedMarginPct(profit, turnover)),
          turnover,
          qty: Math.abs(Number(row.netSalesQty ?? 0)),
          sku: nmId || null,
          imageUrl: card?.photoSmallUrl || card?.photoBigUrl || null,
          cogsComplete: !incomplete,
          hasAllocated: Number(row.adsCost ?? 0) > 0,
        });
        if (Number(row.adsCost ?? 0) > 0) allocatedFooter = true;
      }
    } else {
      const analytics = await getProfitAnalyticsOzon({
        companyName: cab.companyName,
        dateFrom: params.from,
        dateTo: params.to,
      });
      for (const row of analytics.rows ?? []) {
        const incomplete =
          row.costCoverageIncomplete === true || row.costResolved === false;
        const profit = Number(row.netProfitAfterTax ?? 0);
        const turnover = Number(row.economicTurnover ?? row.revenue ?? 0);
        const vendor = String(row.vendorCode ?? "").trim();
        const nmId = String(row.nmId ?? "").trim();
        const id = await resolveOzonHumanIdentity(cab.companyName, nmId, vendor);
        const label =
          id.humanArticle || vendor || (nmId ? `Ozon SKU ${nmId}` : "UNKNOWN");
        const exactFamily =
          id.mappingConfidence === "EXACT" && id.humanArticle
            ? id.humanArticle.trim().toUpperCase()
            : null;
        rawItems.push({
          key: `OZON|${cab.companyName}|${nmId || label.toUpperCase()}`,
          exactFamilyKey: exactFamily,
          label,
          companyName: cab.companyName,
          marketplace: "OZON",
          profit,
          marginPct: incomplete
            ? null
            : Number(row.marginProfitPercent ?? derivedMarginPct(profit, turnover)),
          turnover,
          qty: Math.abs(Number(row.netSalesQty ?? 0)),
          sku: nmId || null,
          imageUrl: id.imageUrl,
          cogsComplete: !incomplete,
          hasAllocated:
            Number(row.allocatedAdsAmount ?? 0) !== 0 ||
            Number(row.allocatedOtherAmount ?? 0) !== 0,
        });
        if (
          Number(row.allocatedAdsAmount ?? 0) !== 0 ||
          Number(row.allocatedOtherAmount ?? 0) !== 0
        ) {
          allocatedFooter = true;
        }
      }
    }
  }

  const isAll = !params.companyName && !params.marketplace;
  let excludedIncomplete = 0;

  if (isAll) {
    // Group by exact family OR keep singleton by identity key.
    const groups = new Map<string, ProfitAgg[]>();
    for (const it of rawItems) {
      const gKey = it.exactFamilyKey
        ? `ALL|FAMILY|${it.exactFamilyKey}`
        : it.key;
      const list = groups.get(gKey) ?? [];
      list.push(it);
      groups.set(gKey, list);
    }
    const items: ProfitAgg[] = [];
    for (const [gKey, members] of groups) {
      if (members.some((m) => !m.cogsComplete)) {
        excludedIncomplete += members.length;
        continue; // fail-closed: partial family never ranks as complete
      }
      if (members.length === 1 && !members[0].exactFamilyKey) {
        items.push(members[0]);
        continue;
      }
      const profit = members.reduce((s, m) => s + m.profit, 0);
      const turnover = members.reduce((s, m) => s + m.turnover, 0);
      const qty = members.reduce((s, m) => s + m.qty, 0);
      const first = members[0];
      items.push({
        key: gKey,
        exactFamilyKey: first.exactFamilyKey,
        label: first.exactFamilyKey
          ? first.label
          : first.label,
        companyName: "Весь бизнес",
        marketplace: "ALL",
        profit,
        marginPct: derivedMarginPct(profit, turnover),
        turnover,
        qty,
        sku: first.sku,
        imageUrl: members.find((m) => m.imageUrl)?.imageUrl ?? null,
        cogsComplete: true,
        hasAllocated: members.some((m) => m.hasAllocated),
      });
    }
    return { items, excludedIncomplete, allocatedFooter };
  }

  const items: ProfitAgg[] = [];
  for (const it of rawItems) {
    if (!it.cogsComplete) {
      excludedIncomplete += 1;
      continue;
    }
    items.push(it);
  }
  return { items, excludedIncomplete, allocatedFooter };
}

function toRankItemsFromOrders(
  orders: OrderUniverseRow[],
  criterion: "amt" | "qty",
  limit: number,
): TopRankItem[] {
  const sorted = sortOrderUniverse(orders, criterion);
  return sorted.slice(0, limit).map((o) => ({
    key: o.identityKey,
    label: o.label,
    companyName: o.companyName,
    marketplace: o.marketplace,
    qty: o.qty,
    ordersAmount: o.amount,
    profit: null,
    marginPct: null,
    turnover: null,
    imageUrl: o.imageUrl,
    sku: o.sku,
    cogsComplete: true,
  }));
}

function toRankItemsFromProfit(
  profits: ProfitAgg[],
  criterion: "prf" | "mrg" | "loss",
  limit: number,
): TopRankItem[] {
  let list = [...profits];
  if (criterion === "loss") {
    list = list
      .filter((p) => p.profit < 0)
      .sort(
        (a, b) =>
          a.profit - b.profit || a.key.localeCompare(b.key),
      );
  } else if (criterion === "prf") {
    list = list.sort(
      (a, b) => b.profit - a.profit || a.key.localeCompare(b.key),
    );
  } else {
    list = list
      .filter((p) => p.marginPct != null && Number.isFinite(p.marginPct))
      .sort(
        (a, b) =>
          (b.marginPct ?? -Infinity) - (a.marginPct ?? -Infinity) ||
          b.profit - a.profit ||
          a.key.localeCompare(b.key),
      );
  }
  return list.slice(0, limit).map((p) => ({
    key: p.key,
    label: p.label,
    companyName: p.companyName,
    marketplace: p.marketplace,
    qty: p.qty,
    ordersAmount: 0,
    profit: p.profit,
    marginPct: p.marginPct,
    turnover: p.turnover,
    imageUrl: p.imageUrl,
    sku: p.sku,
    cogsComplete: p.cogsComplete,
  }));
}

function formatResultText(params: {
  state: TopFlowState;
  rangeLabel: string;
  scopeTitle: string;
  items: TopRankItem[];
}): string {
  const { state, rangeLabel, scopeTitle, items } = params;
  const isLoss = state.criterion === "loss";
  const isProfit =
    state.criterion === "prf" || state.criterion === "mrg" || state.criterion === "loss";
  const lines: string[] = [];

  if (isLoss) {
    lines.push(`🔻 УБЫТОЧНЫЕ ТОВАРЫ`);
  } else if (state.criterion === "prf") {
    lines.push(`💰 ТОП ПО ПРИБЫЛИ`);
  } else if (state.criterion === "mrg") {
    lines.push(`📊 ТОП ПО МАРЖЕ`);
  } else {
    lines.push(`🏆 ${scopeTitle}`);
  }

  const status =
    isProfit && state.statusLabel === "PRELIMINARY" ? " · ПРЕДВАРИТЕЛЬНО" : "";
  lines.push(`${rangeLabel} · ${criterionLabel(state.criterion)}${status}`);
  if (isProfit && (state.criterion === "prf" || state.criterion === "mrg")) {
    lines.push(`${scopeTitle}`);
  }
  lines.push("");

  if (items.length === 0) {
    lines.push(
      isLoss
        ? "✅ Убыточных товаров за период нет."
        : "Нет данных за выбранный период.",
    );
  } else {
    items.forEach((it, i) => {
      const photo = it.imageUrl ? " · 📷" : "";
      if (state.criterion === "amt") {
        lines.push(`${i + 1}. ${it.label} · ${Math.round(it.qty)} шт`);
        lines.push(`   ${money(it.ordersAmount)}${photo}`);
      } else if (state.criterion === "qty") {
        lines.push(
          `${i + 1}. ${it.label} · ${Math.round(it.qty)} шт · ${money(it.ordersAmount)}${photo}`,
        );
      } else if (state.criterion === "prf") {
        lines.push(`${i + 1}. ${it.label}`);
        lines.push(
          `   Прибыль ${moneySigned(it.profit ?? 0)} · маржа ${pct(it.marginPct)}${photo}`,
        );
        if (it.turnover != null && it.turnover > 0) {
          lines.push(`   Оборот ${money(it.turnover)}`);
        }
      } else if (state.criterion === "mrg") {
        lines.push(`${i + 1}. ${it.label}`);
        lines.push(
          `   Маржа ${pct(it.marginPct)} · прибыль ${moneySigned(it.profit ?? 0)}${photo}`,
        );
      } else {
        lines.push(`${i + 1}. ${it.label}`);
        lines.push(
          `   Убыток ${moneySigned(it.profit ?? 0)} · маржа ${pct(it.marginPct)}${photo}`,
        );
        if (it.turnover != null && it.turnover > 0) {
          lines.push(`   Оборот ${money(it.turnover)}`);
        }
      }
    });
  }

  if (isProfit && state.excludedIncomplete > 0) {
    lines.push("");
    lines.push(
      `⚠️ ${state.excludedIncomplete} товаров не имеют полной себестоимости.`,
    );
    lines.push(
      `Не включены в рейтинг: ${state.excludedIncomplete} товаров без полной себестоимости`,
    );
  }
  if (isProfit && state.allocatedFooter) {
    lines.push("");
    lines.push(`ℹ️ Прибыль включает распределённые общие расходы.`);
  }

  return lines.join("\n");
}

async function computeAndRender(
  state: TopFlowState,
  send: (text: string, replyMarkup?: Record<string, unknown>) => Promise<unknown>,
) {
  const range = resolveTopPeriodRange(state.period, state.customFrom, state.customTo);
  const scope = scopeMeta(state.scope);
  const isProfit =
    state.criterion === "prf" || state.criterion === "mrg" || state.criterion === "loss";

  let items: TopRankItem[] = [];
  if (isProfit) {
    const { items: profits, excludedIncomplete, allocatedFooter } =
      await loadProfitRanks({
        from: range.from,
        to: range.to,
        companyName: scope.companyName,
        marketplace: scope.marketplace,
      });
    state.excludedIncomplete = excludedIncomplete;
    state.allocatedFooter = allocatedFooter;
    state.statusLabel = excludedIncomplete > 0 ? "PRELIMINARY" : "FINAL";
    items = toRankItemsFromProfit(profits, state.criterion as any, state.limit);
  } else {
    const universe = await loadCompleteOrderUniverse({
      from: range.from,
      to: range.to,
      companyName: scope.companyName,
      marketplace: scope.marketplace,
      mergeAllExactFamily: state.scope === "all",
    });
    state.excludedIncomplete = 0;
    state.allocatedFooter = false;
    state.statusLabel = "FINAL";
    items = toRankItemsFromOrders(
      universe.rows,
      state.criterion as "amt" | "qty",
      state.limit,
    );
  }

  state.lastItems = items;
  const text = formatResultText({
    state,
    rangeLabel: range.label,
    scopeTitle: scope.title,
    items,
  });
  await send(text, resultNavKeyboard(state));
}

export async function openTopProductsFlow(params: {
  chatId: string;
  seedBusinessDate?: string | null;
  send: (text: string, replyMarkup?: Record<string, unknown>) => Promise<unknown>;
}) {
  const existing = await loadFlow(params.chatId);
  const state = defaultState(params.chatId, params.seedBusinessDate);
  await saveFlow(params.chatId, state, existing.sessionId);
  await params.send(
    ["🏆 Топ товаров", "", "Выберите период:"].join("\n"),
    topPeriodKeyboard(),
  );
}

export async function handleTopProductsCallback(params: {
  chatId: string;
  data: string;
  answer: (text?: string) => Promise<unknown>;
  send: (text: string, replyMarkup?: Record<string, unknown>) => Promise<unknown>;
  showMainMenu: () => Promise<unknown>;
}): Promise<boolean> {
  if (!params.data.startsWith("top:")) return false;
  await params.answer();

  const loaded = await loadFlow(params.chatId);
  let state = loaded.state ?? defaultState(params.chatId);
  let sessionId = loaded.sessionId;

  if (params.data === "top:open" || params.data.startsWith("top:open:")) {
    const seed = params.data.startsWith("top:open:")
      ? params.data.slice("top:open:".length)
      : null;
    await openTopProductsFlow({
      chatId: params.chatId,
      seedBusinessDate: seed,
      send: params.send,
    });
    return true;
  }

  if (params.data === "top:nav:menu") {
    await params.showMainMenu();
    return true;
  }
  if (params.data === "top:nav:per") {
    await params.send("Выберите период:", topPeriodKeyboard());
    return true;
  }
  if (params.data === "top:nav:scp") {
    await params.send("Выберите кабинет:", topScopeKeyboard());
    return true;
  }
  if (params.data === "top:nav:crit") {
    await params.send("Выберите критерий:", topCriterionKeyboard());
    return true;
  }

  if (params.data.startsWith("top:per:")) {
    const key = params.data.slice("top:per:".length) as TopPeriodKey;
    if (key === "custom") {
      state.period = "custom";
      state.customStep = "FROM";
      state.customFrom = null;
      state.customTo = null;
      sessionId = await saveFlow(params.chatId, state, sessionId);
      await params.send("📅 Введите дату начала периода (ДД.ММ.ГГГГ):");
      return true;
    }
    state.period = key;
    state.customStep = "NONE";
    sessionId = await saveFlow(params.chatId, state, sessionId);
    await params.send("Выберите кабинет:", topScopeKeyboard());
    return true;
  }

  if (params.data.startsWith("top:scp:")) {
    state.scope = params.data.slice("top:scp:".length) as TopScopeKey;
    sessionId = await saveFlow(params.chatId, state, sessionId);
    await params.send("Выберите критерий:", topCriterionKeyboard());
    return true;
  }

  if (params.data.startsWith("top:crit:")) {
    state.criterion = params.data.slice("top:crit:".length) as TopCriterionKey;
    sessionId = await saveFlow(params.chatId, state, sessionId);
    if (state.lastItems.length === 0) {
      await params.send("Сколько позиций показать?", topLimitKeyboard());
      return true;
    }
    await params.send("Считаю…");
    await computeAndRender(state, params.send);
    await saveFlow(params.chatId, state, sessionId);
    return true;
  }

  if (params.data.startsWith("top:lim:")) {
    const n = Number(params.data.slice("top:lim:".length));
    state.limit = (n === 3 || n === 10 ? n : 5) as TopLimitKey;
    await params.send("Считаю…");
    await computeAndRender(state, params.send);
    await saveFlow(params.chatId, state, sessionId);
    return true;
  }

  if (params.data.startsWith("top:item:")) {
    const idx = Number(params.data.slice("top:item:".length));
    const item = state.lastItems[idx];
    if (!item) {
      await params.send("Позиция устарела. Откройте топ заново.");
      return true;
    }
    const caption = [
      item.label,
      `${item.companyName} · ${item.marketplace}`,
      item.sku ? `SKU: ${item.sku}` : null,
      `Заказы: ${Math.round(item.qty)} шт`,
      item.ordersAmount > 0 ? `Сумма заказов: ${money(item.ordersAmount)}` : null,
      item.turnover != null ? `Оборот: ${money(item.turnover)}` : null,
      item.profit != null ? `Прибыль: ${moneySigned(item.profit)}` : null,
      item.marginPct != null ? `Маржа: ${pct(item.marginPct)}` : null,
      `Себестоимость: ${item.cogsComplete ? "полная" : "неполная"}`,
    ]
      .filter(Boolean)
      .join("\n");
    if (item.imageUrl) {
      const photo = await sendTelegramPhoto({
        chatId: params.chatId,
        photoUrl: item.imageUrl,
        caption: caption.slice(0, 1024),
      });
      if (photo) return true;
    }
    await params.send(caption, resultNavKeyboard(state));
    return true;
  }

  return true;
}

export async function handleTopProductsTextInput(params: {
  chatId: string;
  text: string;
  send: (text: string, replyMarkup?: Record<string, unknown>) => Promise<unknown>;
}): Promise<boolean> {
  const loaded = await loadFlow(params.chatId);
  if (!loaded.state || loaded.state.customStep === "NONE") return false;
  const state = loaded.state;
  const m = String(params.text)
    .trim()
    .match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!m) {
    await params.send("Некорректная дата. Формат: ДД.ММ.ГГГГ");
    return true;
  }
  const iso = `${m[3]}-${m[2]}-${m[1]}`;
  if (state.customStep === "FROM") {
    state.customFrom = iso;
    state.customStep = "TO";
    await saveFlow(params.chatId, state, loaded.sessionId);
    await params.send("Введите дату конца периода (ДД.ММ.ГГГГ):");
    return true;
  }
  if (state.customStep === "TO") {
    state.customTo = iso;
    if (state.customFrom && state.customTo < state.customFrom) {
      await params.send("Дата конца должна быть ≥ даты начала.");
      return true;
    }
    // max 92 days safety
    if (state.customFrom) {
      const days =
        (Date.parse(state.customTo) - Date.parse(state.customFrom)) /
        (24 * 3600 * 1000);
      if (days > 92) {
        await params.send("Максимальный период — 92 дня.");
        return true;
      }
    }
    state.period = "custom";
    state.customStep = "NONE";
    await saveFlow(params.chatId, state, loaded.sessionId);
    await params.send(
      `Период: ${formatRuRange(state.customFrom!, state.customTo!)}\nВыберите кабинет:`,
      topScopeKeyboard(),
    );
    return true;
  }
  return false;
}

/** Morning report inline actions (V2). */
export function morningReportInlineKeyboard(params: {
  businessDate: string;
  unresolvedSkuCount?: number | null;
}) {
  const costLabel =
    params.unresolvedSkuCount && params.unresolvedSkuCount > 0
      ? `💰 Себестоимость (${params.unresolvedSkuCount})`
      : "💰 Себестоимость";
  return {
    inline_keyboard: [
      [
        {
          text: "🏆 Топ товаров",
          callback_data: `top:open:${params.businessDate}`,
        },
        {
          text: "📊 Подробнее",
          callback_data: "report_menu",
        },
      ],
      [
        { text: "📣 Реклама", callback_data: "ads:menu" },
        {
          text: costLabel,
          callback_data: `pcost:open:${params.businessDate}`,
        },
      ],
    ],
  };
}
