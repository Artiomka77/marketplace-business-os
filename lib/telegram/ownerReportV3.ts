/**
 * Telegram Owner Report V3 — Message 1 financial summary + Message 2 TOP-3/ads.
 * Extends approved financial core; never invents unavailable metrics.
 */
import type { DailyReport } from "@/lib/telegram/dailyReport";
import {
  compactChangeSuffix,
  compactPointSuffix,
  formatCompactMoney,
  formatMoney,
  formatNumber,
  formatPercent,
  formatSignedMoney,
  shouldShowCashFlowPercent,
} from "@/lib/telegram/dailyReport";
import {
  buildLevelComparisonMaps,
  dynPct,
  dynPp,
  joinDyn,
  type LevelComparisonMaps,
  type LevelDynamics,
} from "@/lib/telegram/ownerReportV3Dynamics";

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
  sku?: string | null;
  /** @deprecated generic titles must not be shown */
  secondaryTitle?: string | null;
  ozonOffer?: string | null;
  humanArticle?: string | null;
  size?: string | null;
  imageUrl?: string | null;
  mappingPath?: string | null;
  mappingConfidence?: "EXACT" | null;
};

export type CounterStatus =
  | "COUNTERS_TRUE_ZERO"
  | "COUNTERS_AVAILABLE_NONZERO"
  | "COUNTERS_MISSING"
  | "COUNTERS_STALE";

export type AdSpendSemantics = "SAME_AS_PNL" | "PERFORMANCE_PARTIAL" | "FUNNEL_ONLY";

export type CabinetAdFunnel = {
  companyName: string;
  marketplace: "WB" | "OZON";
  spend: number;
  financialSpend: number;
  financialDrr: number;
  spendSemantics: AdSpendSemantics;
  impressions: number | null;
  clicks: number | null;
  ctr: number | null;
  cpc: number | null;
  adOrders: number | null;
  cpo: number | null;
  counterStatus: CounterStatus;
  economicTurnover: number;
  drr: number;
  top3: TopOrderItem[];
  top3Source: "TRUE_ORDERS" | "UNAVAILABLE";
  distinctOrderedArticles?: number;
};

export type OwnerReportV3Extras = {
  businessTop3: TopOrderItem[];
  businessTop3Source: "TRUE_ORDERS" | "INCOMPLETE" | "UNAVAILABLE";
  businessTop3CabinetCount: number;
  businessTop3Complete: boolean;
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
  m: DailyReport["companies"][0]["wb"],
  dyn: LevelDynamics | null
) {
  if (m.financialUnavailable) {
    return [
      `${emoji} ${label}`,
      `⚠️ Финансовые данные неполны — не равны 0 ₽.`,
      `🛒 Заказы         ${formatNumber(m.ordersQty)} шт · ${money(m.ordersAmount)}${dynPct(dyn?.ordersAmountPercent ?? null)}`,
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
    `🛒 ${formatNumber(m.ordersQty)} шт · ${money(m.ordersAmount)}${dynPct(dyn?.ordersAmountPercent ?? null)}`,
    `📈 Оборот ${money(eco)}${dynPct(dyn?.economicTurnoverPercent ?? null)}`,
    taxable === undefined
      ? `🧾 Налог. н/д`
      : `🧾 Налог. ${money(taxable)}${dynPct(dyn?.taxableRevenuePercent ?? null)}`,
    cogs === null
      ? `📦 COGS н/д`
      : `📦 COGS ${money(cogs)}${
          cogsShare === null ? "" : ` · ${pct(cogsShare)}`
        }${joinDyn(
          dynPct(dyn?.totalCostPercent ?? null, true),
          dynPp(dyn?.cogsSharePointDiff ?? null)
        )}`,
    `📣 Реклама ${money(m.adSpend)} · ДРР ${pct(m.drrByEconomicTurnover)}${joinDyn(
      dynPct(dyn?.adSpendPercent ?? null, true),
      dynPp(dyn?.drrPointDiff ?? null)
    )}`,
    profit === null
      ? `💰 Прибыль недоступна`
      : `💰 Прибыль ${formatSignedMoney(profit)}${
          marg === null ? "" : ` · ${pct(marg)}`
        }${joinDyn(
          dynPct(dyn?.netProfitPercent ?? null),
          dynPp(dyn?.marginPointDiff ?? null)
        )}`,
    `📦 Остатки ${formatNumber(m.stockQty)} шт`,
  ];
  return lines.join("\n");
}

function formatCompanyBlock(
  company: DailyReport["companies"][0],
  maps: LevelComparisonMaps
) {
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
  const ordersQty = company.wb.ordersQty + company.ozon.ordersQty;
  const ordersAmount = company.wb.ordersAmount + company.ozon.ordersAmount;
  const ads = company.wb.adSpend + company.ozon.adSpend;
  const drr = eco > 0.0001 ? (ads / eco) * 100 : 0;
  const dyn = maps.company.get(company.companyName) ?? null;

  const lines = [
    `👤 ${company.companyName}`,
    `🛒 Заказы: ${formatNumber(ordersQty)} · ${money(ordersAmount)}${dynPct(dyn?.ordersAmountPercent ?? null)}`,
    `📈 Оборот: ${money(eco)}${dynPct(dyn?.economicTurnoverPercent ?? null)}`,
    `📣 Реклама: ${money(ads)} · ДРР ${pct(drr)}${joinDyn(
      dynPct(dyn?.adSpendPercent ?? null, true),
      dynPp(dyn?.drrPointDiff ?? null)
    )}`,
    companyNet === null
      ? `💰 Прибыль: недоступно`
      : `💰 Прибыль: ${formatSignedMoney(companyNet)}${
          companyMargin === null ? "" : ` · маржа ${pct(companyMargin)}`
        }${joinDyn(
          dynPct(dyn?.netProfitPercent ?? null),
          dynPp(dyn?.marginPointDiff ?? null)
        )}`,
    `💸 ДДС: ${money(company.finance.netCashFlow)}`,
  ];
  if (Math.abs(company.finance.ownerWithdrawals) > 0.5) {
    lines.push(`💳 Вывод: ${money(company.finance.ownerWithdrawals)}`);
    if (afterOwner !== null) {
      lines.push(
        `💵 После вывода: ${formatSignedMoney(afterOwner)}${dynPct(
          dyn?.afterOwnerPercent ?? null
        )}`
      );
    }
  }
  lines.push(`📦 Остатки: ${formatNumber(stock)} шт`, "");
  lines.push(
    formatMarketplaceCabinet(
      "🟣",
      "WB",
      company.wb,
      maps.cabinet.get(`${company.companyName}::WB`) ?? null
    ),
    ""
  );
  lines.push(
    formatMarketplaceCabinet(
      "🔵",
      "Ozon",
      company.ozon,
      maps.cabinet.get(`${company.companyName}::OZON`) ?? null
    )
  );
  return lines.join("\n");
}

export function formatOwnerReportV3Message1(
  report: DailyReport,
  previousReport: DailyReport | null = null
): string {
  const dateIso = primaryDateIso(report);
  const dateRu = formatRuDateIso(dateIso);
  const comparisonDate = report.comparison
    ? formatRuDateIso(
        String(report.comparison.dateLabel).match(/\d{4}-\d{2}-\d{2}/)?.[0] ??
          report.comparison.dateLabel
      )
    : "";

  const maps = buildLevelComparisonMaps(
    report,
    previousReport ?? report.previousReport ?? null
  );

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

  const cmp = report.comparison?.totals ?? null;
  const ddsDyn =
    cmp &&
    shouldShowCashFlowPercent({
      current: cmp.netCashFlowCurrent,
      previous: cmp.netCashFlowPrevious,
      percent: cmp.netCashFlowPercent,
    })
      ? compactChangeSuffix(cmp.netCashFlowPercent)
      : "";

  const cogsDynParts: string[] = [];
  if (cmp?.totalCostPercent != null) {
    cogsDynParts.push(compactChangeSuffix(cmp.totalCostPercent).trim());
  }
  if (cmp?.cogsSharePointDiff != null) {
    cogsDynParts.push(compactPointSuffix(cmp.cogsSharePointDiff).trim());
  }
  const cogsDyn =
    cogsDynParts.filter(Boolean).length > 0
      ? ` ${cogsDynParts.filter(Boolean).join(" · ")}`
      : "";

  const adsDynParts: string[] = [];
  if (cmp?.adSpendPercent != null) {
    adsDynParts.push(compactChangeSuffix(cmp.adSpendPercent, true).trim());
  }
  if (cmp?.drrByEconomicTurnoverPointDiff != null) {
    adsDynParts.push(
      compactPointSuffix(cmp.drrByEconomicTurnoverPointDiff).trim()
    );
  }
  const adsDyn =
    adsDynParts.filter(Boolean).length > 0
      ? ` ${adsDynParts.filter(Boolean).join(" · ")}`
      : "";

  const profitDynParts: string[] = [];
  if (cmp?.netProfitImpactPercent != null) {
    profitDynParts.push(compactChangeSuffix(cmp.netProfitImpactPercent).trim());
  }
  if (cmp?.marginPointDiff != null) {
    profitDynParts.push(compactPointSuffix(cmp.marginPointDiff).trim());
  }
  const profitDyn =
    profitDynParts.filter(Boolean).length > 0
      ? ` ${profitDynParts.filter(Boolean).join(" · ")}`
      : "";

  const business = [
    `🏢 ИТОГО ПО БИЗНЕСУ`,
    "",
    `🛒 Заказы          ${formatNumber(report.totals.ordersQty)} шт · ${money(
      report.totals.ordersAmount
    )}${compactChangeSuffix(cmp?.ordersAmountPercent ?? null)}`,
    combinedUnavailable
      ? `📈 Экон. оборот    недоступен`
      : `📈 Экон. оборот    ${compact(eco)}${compactChangeSuffix(
          cmp?.economicTurnoverPercent ?? null
        )}`,
    combinedUnavailable
      ? `🧾 Налог. выручка  недоступна`
      : `🧾 Налог. выручка  ${compact(report.totals.taxableRevenue)}${compactChangeSuffix(
          cmp?.taxableRevenuePercent ?? null
        )}`,
    "",
    cogs === undefined || combinedUnavailable
      ? `📦 Себестоимость   н/д`
      : `📦 Себестоимость   ${compact(cogs)}${
          cogsShare === null ? "" : ` · ${pct(cogsShare)}`
        }${cogsDyn}`,
    combinedUnavailable
      ? `📣 Реклама         недоступна`
      : `📣 Реклама         ${compact(report.totals.adSpend)} · ДРР ${pct(
          report.totals.drrByEconomicTurnover
        )}${adsDyn}`,
    profit === null
      ? `💰 Чистая прибыль  недоступна`
      : `💰 Чистая прибыль  ${compact(profit)}${
          marg === null ? "" : ` · маржа ${pct(marg)}`
        }${profitDyn}`,
    "",
    `💸 ДДС             ${compact(report.totals.netCashFlow)}${ddsDyn}`,
    `💳 Вывод            ${money(report.totals.ownerWithdrawals)}`,
    afterOwner === null
      ? `💵 После вывода     недоступна`
      : `💵 После вывода     ${compact(afterOwner)}${compactChangeSuffix(
          cmp?.afterOwnerWithdrawalPercent ?? null
        )}`,
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
    formatCompanyBlock(c, maps)
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

export function escapeTelegramHtml(text: string) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function photoIconHtml(url: string | null | undefined) {
  if (!url) return "";
  const safe = escapeTelegramHtml(url);
  return ` <a href="${safe}">📷</a>`;
}

function formatTop3List(items: TopOrderItem[], asHtml: boolean) {
  if (items.length === 0) {
    return asHtml
      ? escapeTelegramHtml("н/д — точный SKU-источник заказов недоступен")
      : "н/д — точный SKU-источник заказов недоступен";
  }
  return items
    .slice(0, 3)
    .map((it, i) => {
      const esc = asHtml ? escapeTelegramHtml : (s: string) => s;
      const qtyAmt = `${formatNumber(it.qty)} шт · ${money(it.amount)}`;
      if (it.marketplace === "OZON" || it.ozonOffer || it.humanArticle) {
        const offer = it.ozonOffer || it.article;
        const parts = [offer];
        if (it.humanArticle && it.humanArticle !== offer) {
          parts.push(it.humanArticle);
        }
        if (it.size) parts.push(`р.${it.size}`);
        const head = `${i + 1}. ${parts.map(esc).join(" · ")}${
          asHtml ? photoIconHtml(it.imageUrl) : it.imageUrl ? " 📷" : ""
        }`;
        return `${head}\n   ${esc(qtyAmt)}`;
      }
      // WB / business: single line, no generic title
      const head = `${i + 1}. ${esc(it.article)} · ${esc(qtyAmt)}${
        asHtml ? photoIconHtml(it.imageUrl) : it.imageUrl ? " 📷" : ""
      }`;
      return head;
    })
    .join("\n");
}

function formatCounter(value: number | null, status: CounterStatus) {
  if (
    status === "COUNTERS_MISSING" ||
    status === "COUNTERS_STALE" ||
    value === null
  ) {
    return "н/д";
  }
  return formatNumber(value);
}

function formatAdFunnelBlock(funnel: CabinetAdFunnel) {
  const lines: string[] = [`📣 РЕКЛАМА`];
  if (funnel.spendSemantics === "PERFORMANCE_PARTIAL") {
    lines.push(`Performance:`);
    lines.push(`Расход      ${money(funnel.spend)}`);
    lines.push(
      `Показы      ${formatCounter(funnel.impressions, funnel.counterStatus)}`
    );
    lines.push(
      `Клики       ${formatCounter(funnel.clicks, funnel.counterStatus)}`
    );
    if (
      funnel.ctr !== null &&
      funnel.counterStatus !== "COUNTERS_MISSING" &&
      funnel.counterStatus !== "COUNTERS_STALE"
    ) {
      lines.push(`CTR         ${pct(funnel.ctr)}`);
    } else if (
      funnel.counterStatus === "COUNTERS_MISSING" ||
      funnel.counterStatus === "COUNTERS_STALE"
    ) {
      lines.push(`CTR         н/д`);
    }
    if (
      funnel.cpc !== null &&
      funnel.counterStatus !== "COUNTERS_MISSING" &&
      funnel.counterStatus !== "COUNTERS_STALE"
    ) {
      lines.push(`CPC         ${money(funnel.cpc)}`);
    } else if (
      funnel.counterStatus === "COUNTERS_MISSING" ||
      funnel.counterStatus === "COUNTERS_STALE"
    ) {
      lines.push(`CPC         н/д`);
    }
    if (funnel.adOrders !== null) {
      lines.push(`Рекл. заказы ${formatNumber(funnel.adOrders)}`);
    }
    if (funnel.cpo !== null) lines.push(`CPO          ${money(funnel.cpo)}`);
    lines.push(
      `Реклама P&L: ${money(funnel.financialSpend)} · ДРР ${pct(
        funnel.financialDrr
      )}`
    );
  } else {
    lines.push(
      `Расход      ${money(funnel.spend)} · ДРР ${pct(funnel.drr)}`
    );
    lines.push(
      `Показы      ${formatCounter(funnel.impressions, funnel.counterStatus)}`
    );
    lines.push(
      `Клики       ${formatCounter(funnel.clicks, funnel.counterStatus)}`
    );
    if (
      funnel.ctr !== null &&
      funnel.counterStatus !== "COUNTERS_MISSING" &&
      funnel.counterStatus !== "COUNTERS_STALE"
    ) {
      lines.push(`CTR         ${pct(funnel.ctr)}`);
    } else if (
      funnel.counterStatus === "COUNTERS_MISSING" ||
      funnel.counterStatus === "COUNTERS_STALE"
    ) {
      lines.push(`CTR         н/д`);
    }
    if (
      funnel.cpc !== null &&
      funnel.counterStatus !== "COUNTERS_MISSING" &&
      funnel.counterStatus !== "COUNTERS_STALE"
    ) {
      lines.push(`CPC         ${money(funnel.cpc)}`);
    } else if (
      funnel.counterStatus === "COUNTERS_MISSING" ||
      funnel.counterStatus === "COUNTERS_STALE"
    ) {
      lines.push(`CPC         н/д`);
    }
    if (funnel.adOrders !== null) {
      lines.push(`Рекл. заказы ${formatNumber(funnel.adOrders)}`);
    }
    if (funnel.cpo !== null) lines.push(`CPO          ${money(funnel.cpo)}`);
  }
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
  const esc = escapeTelegramHtml;

  const parts = [
    esc(`📦 AvoroFin — товары и реклама`),
    esc(dateRu),
    "",
  ];

  if (!extras.businessTop3Complete) {
    parts.push(
      esc(`🏆 ТОП-3 по доступным данным — неполно`),
      esc(`(источники: ${extras.businessTop3CabinetCount}/4 кабинетов)`),
      "",
      formatTop3List(top, true)
    );
  } else {
    parts.push(esc(`🏆 ТОП-3 ПО ВСЕМУ БИЗНЕСУ`), "", formatTop3List(top, true));
    if (top.length > 0) {
      parts.push(
        "",
        esc(`Всего TOP-3:`),
        esc(`${formatNumber(topQty)} шт · ${money(topAmt)}`)
      );
    }
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
      const metrics = mp === "WB" ? company.wb : company.ozon;
      const fallback: CabinetAdFunnel = {
        companyName: company.companyName,
        marketplace: mp,
        spend: metrics.adSpend,
        financialSpend: metrics.adSpend,
        financialDrr: metrics.drrByEconomicTurnover,
        spendSemantics: "SAME_AS_PNL",
        impressions: null,
        clicks: null,
        ctr: null,
        cpc: null,
        adOrders: null,
        cpo: null,
        counterStatus: "COUNTERS_MISSING",
        economicTurnover: metrics.economicTurnover ?? 0,
        drr: metrics.drrByEconomicTurnover,
        top3: [],
        top3Source: "UNAVAILABLE",
      };
      parts.push(
        "",
        esc("──────────────"),
        "",
        esc(`👤 ${company.companyName} · ${emoji} ${label}`),
        "",
        esc(`🏆 ТОП-3 заказов`),
        formatTop3List(funnel?.top3 ?? [], true),
        "",
        esc(formatAdFunnelBlock(funnel ?? fallback))
      );
    }
  }

  return parts.join("\n");
}

export function formatOwnerReportV3(
  report: DailyReport,
  extras: OwnerReportV3Extras,
  previousReport: DailyReport | null = null
): OwnerReportV3Messages {
  return {
    message1: formatOwnerReportV3Message1(report, previousReport),
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
  escapeTelegramHtml,
};
