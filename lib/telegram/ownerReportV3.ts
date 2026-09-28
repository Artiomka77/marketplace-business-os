/**
 * Telegram Owner Report V3 — Message 1 financial summary + Message 2 TOP-3/ads.
 * Extends approved financial core; never invents unavailable metrics.
 */
import type { DailyReport } from "@/lib/telegram/dailyReport";
import {
  formatCompactMoney,
  formatMoney,
  formatNumber,
  formatPercent,
  formatSignedMoney,
} from "@/lib/telegram/dailyReport";

export type OwnerReportV3Messages = {
  message1: string;
  message2: string;
  messageCount: 2;
};

export type TopOrderItem = {
  article: string;
  qty: number;
  amount: number;
  companyName?: string;
  marketplace?: "WB" | "OZON";
};

export type CabinetAdFunnel = {
  companyName: string;
  marketplace: "WB" | "OZON";
  spend: number;
  impressions: number;
  clicks: number;
  ctr: number | null;
  cpc: number | null;
  adOrders: number | null;
  cpo: number | null;
  economicTurnover: number;
  drr: number;
  top3: TopOrderItem[];
  top3Source: "TRUE_ORDERS" | "UNAVAILABLE";
};

export type OwnerReportV3Extras = {
  businessTop3: TopOrderItem[];
  businessTop3Source: "TRUE_ORDERS" | "UNAVAILABLE";
  cabinets: CabinetAdFunnel[];
};

function money(n: number) {
  return formatMoney(n);
}

function compact(n: number) {
  return formatCompactMoney(n);
}

function pct(n: number) {
  return formatPercent(n);
}

function share(cogs: number, eco: number) {
  if (!Number.isFinite(eco) || Math.abs(eco) < 0.0001) return null;
  return (cogs / eco) * 100;
}

function margin(profit: number, eco: number) {
  if (!Number.isFinite(eco) || Math.abs(eco) < 0.0001) return null;
  return (profit / eco) * 100;
}

function safeDiv(num: number, den: number) {
  if (!Number.isFinite(den) || Math.abs(den) < 0.0001) return null;
  return num / den;
}

function formatRuDateIso(iso: string) {
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return iso;
  return `${m[3]}.${m[2]}.${m[1]}`;
}

function primaryDateIso(report: DailyReport) {
  const m = String(report.dateLabel ?? "").match(/\d{4}-\d{2}-\d{2}/);
  return m?.[0] ?? "";
}

/** Petrov then Lebedeva; other companies keep name asc. */
export function sortCompaniesOwnerOrder<T extends { companyName: string }>(
  companies: T[]
): T[] {
  const rank = (name: string) => {
    const n = name.toLowerCase();
    if (n.includes("петров")) return 0;
    if (n.includes("лебед")) return 1;
    return 10;
  };
  return [...companies].sort((a, b) => {
    const ra = rank(a.companyName);
    const rb = rank(b.companyName);
    if (ra !== rb) return ra - rb;
    return a.companyName.localeCompare(b.companyName, "ru");
  });
}

function cogsOf(m: {
  totalCost?: number;
  financialUnavailable?: boolean;
}) {
  if (m.financialUnavailable) return null;
  if (m.totalCost === undefined || m.totalCost === null) return null;
  return m.totalCost;
}

function ecoOf(m: {
  economicTurnover?: number;
  salesAmount?: number;
  financialUnavailable?: boolean;
}) {
  if (m.financialUnavailable) return null;
  return m.economicTurnover ?? m.salesAmount ?? null;
}

function formatMarketplaceCabinet(
  emoji: string,
  label: string,
  m: DailyReport["companies"][0]["wb"]
) {
  if (m.financialUnavailable) {
    return [
      `${emoji} ${label}`,
      `⚠️ Финансовые данные неполны — не равны 0 ₽.`,
      `📦 Заказы         ${formatNumber(m.ordersQty)} шт · ${money(m.ordersAmount)}`,
      `📦 Остатки        ${formatNumber(m.stockQty)} шт`,
    ].join("\n");
  }

  const eco = ecoOf(m) ?? 0;
  const cogs = cogsOf(m);
  const cogsShare = cogs === null ? null : share(cogs, eco);
  const profit = m.netProfitUnavailable ? null : m.netProfitAfterTax;
  const marg = profit === null ? null : margin(profit, eco);
  const taxable = m.taxableRevenue;

  const lines = [
    `${emoji} ${label}`,
    `🛒 Заказы         ${formatNumber(m.ordersQty)} шт · ${money(m.ordersAmount)}`,
    `📈 Экон. оборот   ${money(eco)}`,
    taxable === undefined
      ? `🧾 Налог. выручка н/д`
      : `🧾 Налог. выручка ${money(taxable)}`,
    "",
    cogs === null
      ? `📦 Себестоимость  н/д`
      : `📦 Себестоимость  ${money(cogs)}${
          cogsShare === null ? "" : ` · ${pct(cogsShare)}`
        }`,
    `📣 Реклама        ${money(m.adSpend)} · ДРР ${pct(m.drrByEconomicTurnover)}`,
    profit === null
      ? `💰 Прибыль        недоступна`
      : `💰 Прибыль        ${formatSignedMoney(profit)}${
          marg === null ? "" : ` · маржа ${pct(marg)}`
        }`,
    "",
    `📦 Остатки        ${formatNumber(m.stockQty)} шт`,
  ];
  return lines.join("\n");
}

function formatCompanyBlock(company: DailyReport["companies"][0]) {
  const unavailable = Boolean(
    company.wb.financialUnavailable || company.ozon.financialUnavailable
  );
  const wbProfit = company.wb.netProfitUnavailable
    ? 0
    : company.wb.netProfitAfterTax;
  const companyNet =
    unavailable || company.wb.netProfitUnavailable
      ? null
      : wbProfit +
        company.ozon.netProfitAfterTax +
        company.finance.netProfitImpact;
  const eco =
    (ecoOf(company.wb) ?? 0) + (ecoOf(company.ozon) ?? 0);
  const companyMargin =
    companyNet === null ? null : margin(companyNet, eco);
  const stock = company.wb.stockQty + company.ozon.stockQty;
  const afterOwner =
    companyNet === null
      ? null
      : companyNet - company.finance.ownerWithdrawals;

  const lines = [
    `👤 ${company.companyName}`,
    companyNet === null
      ? `💰 Прибыль: недоступно`
      : `💰 Прибыль: ${formatSignedMoney(companyNet)}${
          companyMargin === null ? "" : ` · маржа ${pct(companyMargin)}`
        }`,
    `💸 ДДС: ${money(company.finance.netCashFlow)}`,
  ];
  if (Math.abs(company.finance.ownerWithdrawals) > 0.5) {
    lines.push(`💳 Вывод: ${money(company.finance.ownerWithdrawals)}`);
    if (afterOwner !== null) {
      lines.push(`💵 После вывода: ${formatSignedMoney(afterOwner)}`);
    }
  }
  lines.push(`📦 Остатки: ${formatNumber(stock)} шт`, "");
  lines.push(formatMarketplaceCabinet("🟣", "WB", company.wb), "");
  lines.push(formatMarketplaceCabinet("🔵", "Ozon", company.ozon));
  return lines.join("\n");
}

export function formatOwnerReportV3Message1(report: DailyReport): string {
  const dateIso = primaryDateIso(report);
  const dateRu = formatRuDateIso(dateIso);
  const comparisonDate = report.comparison
    ? formatRuDateIso(
        String(report.comparison.dateLabel).match(/\d{4}-\d{2}-\d{2}/)?.[0] ??
          report.comparison.dateLabel
      )
    : "";

  const combinedUnavailable = Boolean(report.combinedFinancialUnavailable);
  const eco = report.totals.economicTurnover;
  const cogs = report.totals.totalCost;
  const cogsShare =
    cogs === undefined || combinedUnavailable ? null : share(cogs, eco);
  const profit = combinedUnavailable ? null : report.totals.netProfitImpact;
  const marg = profit === null ? null : margin(profit, eco);
  const afterOwner =
    profit === null ? null : profit - report.totals.ownerWithdrawals;

  const periodWord =
    report.periodLabel?.toLowerCase().includes("недел") ||
    String(report.dateLabel).includes("—")
      ? "Период"
      : "Вчера";
  const header = [
    `📊 AvoroFin — сводка собственника`,
    `${periodWord} · ${dateRu}`,
    comparisonDate ? `vs ${comparisonDate}` : "",
  ].filter(Boolean);

  // One compact warning only if incomplete
  const warnings: string[] = [];
  for (const c of report.companies) {
    if (c.ozon.financialUnavailable) {
      warnings.push(
        `• ${c.companyName} · Ozon: нет полного финансового источника за день`
      );
    }
    if (c.wb.financialUnavailable) {
      warnings.push(
        `• ${c.companyName} · WB: нет полного финансового источника за день`
      );
    }
  }
  if (warnings.length > 0) {
    header.push("", "⚠️ Данные неполные:", ...warnings.slice(0, 3));
  }

  const business = [
    `🏢 ИТОГО ПО БИЗНЕСУ`,
    "",
    `🛒 Заказы          ${formatNumber(report.totals.ordersQty)} шт · ${money(
      report.totals.ordersAmount
    )}`,
    combinedUnavailable
      ? `📈 Экон. оборот    недоступен`
      : `📈 Экон. оборот    ${compact(eco)}`,
    combinedUnavailable
      ? `🧾 Налог. выручка  недоступна`
      : `🧾 Налог. выручка  ${compact(report.totals.taxableRevenue)}`,
    "",
    cogs === undefined || combinedUnavailable
      ? `📦 Себестоимость   н/д`
      : `📦 Себестоимость   ${compact(cogs)}${
          cogsShare === null ? "" : ` · ${pct(cogsShare)} оборота`
        }`,
    combinedUnavailable
      ? `📣 Реклама         недоступна`
      : `📣 Реклама         ${compact(report.totals.adSpend)} · ДРР ${pct(
          report.totals.drrByEconomicTurnover
        )}`,
    profit === null
      ? `💰 Чистая прибыль  недоступна`
      : `💰 Чистая прибыль  ${compact(profit)}${
          marg === null ? "" : ` · маржа ${pct(marg)}`
        }`,
    "",
    `💸 ДДС             ${compact(report.totals.netCashFlow)}`,
    `💳 Вывод            ${money(report.totals.ownerWithdrawals)}`,
    afterOwner === null
      ? `💵 После вывода     недоступна`
      : `💵 После вывода     ${compact(afterOwner)}`,
    `📦 Остатки          ${formatNumber(report.totals.stockQty)} шт`,
  ];

  const attention: string[] = [];
  if (report.totals.netCashFlow < 0) {
    attention.push(`🔴 ДДС: ${compact(report.totals.netCashFlow)}`);
  }
  if (profit !== null && profit < 0) {
    attention.push(`🔴 Чистая прибыль отрицательная: ${compact(profit)}`);
  }
  for (const c of sortCompaniesOwnerOrder(report.companies)) {
    for (const item of [
      { mp: "WB" as const, m: c.wb },
      { mp: "Ozon" as const, m: c.ozon },
    ]) {
      if (
        !item.m.financialUnavailable &&
        item.m.adSpend > 0 &&
        (item.m.economicTurnover ?? 0) > 0 &&
        item.m.drrByEconomicTurnover >= 10
      ) {
        const tone = item.m.drrByEconomicTurnover >= 12 ? "🟠" : "🟡";
        attention.push(
          `${tone} ${c.companyName} · ${item.mp}: ДРР ${pct(
            item.m.drrByEconomicTurnover
          )}`
        );
      }
    }
  }

  const companies = sortCompaniesOwnerOrder(report.companies).map((c) =>
    formatCompanyBlock(c)
  );

  const parts = [
    header.join("\n"),
    "",
    business.join("\n"),
  ];
  if (attention.length > 0) {
    parts.push("", "⚠️ ВНИМАНИЕ", ...attention.slice(0, 5));
  }
  for (const block of companies) {
    parts.push("", "──────────────", "", block);
  }
  return parts.join("\n");
}

function formatTop3List(items: TopOrderItem[]) {
  if (items.length === 0) return "н/д — точный SKU-источник заказов недоступен";
  return items
    .slice(0, 3)
    .map(
      (it, i) =>
        `${i + 1}. ${it.article} · ${formatNumber(it.qty)} шт · ${money(
          it.amount
        )}`
    )
    .join("\n");
}

function formatAdFunnelBlock(funnel: CabinetAdFunnel) {
  const lines = [
    `📣 РЕКЛАМА`,
    `Расход      ${money(funnel.spend)} · ДРР ${pct(funnel.drr)}`,
    `Показы      ${formatNumber(funnel.impressions)}`,
    `Клики       ${formatNumber(funnel.clicks)}`,
  ];
  if (funnel.ctr !== null) lines.push(`CTR         ${pct(funnel.ctr)}`);
  if (funnel.cpc !== null) lines.push(`CPC         ${money(funnel.cpc)}`);
  if (funnel.adOrders !== null) {
    lines.push(`Рекл. заказы ${formatNumber(funnel.adOrders)}`);
  }
  if (funnel.cpo !== null) lines.push(`CPO          ${money(funnel.cpo)}`);
  // cart / organic / paid traffic omitted — no exact durable comparable source
  return lines.join("\n");
}

export function formatOwnerReportV3Message2(
  report: DailyReport,
  extras: OwnerReportV3Extras
): string {
  const dateIso = primaryDateIso(report);
  const dateRu = formatRuDateIso(dateIso);
  const top = extras.businessTop3.slice(0, 3);
  const topQty = top.reduce((s, x) => s + x.qty, 0);
  const topAmt = top.reduce((s, x) => s + x.amount, 0);

  const parts = [
    `📦 AvoroFin — товары и реклама`,
    dateRu,
    "",
    `🏆 ТОП-3 ПО ВСЕМУ БИЗНЕСУ`,
    "",
    formatTop3List(top),
  ];
  if (top.length > 0) {
    parts.push(
      "",
      `Всего TOP-3:`,
      `${formatNumber(topQty)} шт · ${money(topAmt)}`
    );
  }

  const order = sortCompaniesOwnerOrder(report.companies);
  for (const company of order) {
    for (const mp of ["WB", "OZON"] as const) {
      const funnel = extras.cabinets.find(
        (c) =>
          c.companyName === company.companyName && c.marketplace === mp
      );
      const emoji = mp === "WB" ? "🟣" : "🔵";
      const label = mp === "WB" ? "WB" : "Ozon";
      parts.push(
        "",
        "──────────────",
        "",
        `👤 ${company.companyName} · ${emoji} ${label}`,
        "",
        `🏆 ТОП-3 заказов`,
        formatTop3List(funnel?.top3 ?? []),
        "",
        formatAdFunnelBlock(
          funnel ?? {
            companyName: company.companyName,
            marketplace: mp,
            spend: mp === "WB" ? company.wb.adSpend : company.ozon.adSpend,
            impressions: 0,
            clicks: 0,
            ctr: null,
            cpc: null,
            adOrders: null,
            cpo: null,
            economicTurnover:
              (mp === "WB"
                ? company.wb.economicTurnover
                : company.ozon.economicTurnover) ?? 0,
            drr:
              mp === "WB"
                ? company.wb.drrByEconomicTurnover
                : company.ozon.drrByEconomicTurnover,
            top3: [],
            top3Source: "UNAVAILABLE",
          }
        )
      );
    }
  }

  return parts.join("\n");
}

export function formatOwnerReportV3(
  report: DailyReport,
  extras: OwnerReportV3Extras
): OwnerReportV3Messages {
  return {
    message1: formatOwnerReportV3Message1(report),
    message2: formatOwnerReportV3Message2(report, extras),
    messageCount: 2,
  };
}

/** Pure helpers exported for tests */
export const ownerReportV3Math = {
  share,
  margin,
  safeDiv,
  sortCompaniesOwnerOrder,
};
