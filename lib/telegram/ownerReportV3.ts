/**
 * Telegram Owner Report V3 — compact morning owner summary (presentation only).
 * Extends approved financial core; never invents unavailable metrics.
 * Detailed ads funnel / per-cabinet TOP-3 remain via formatOwnerReportV3Message2
 * but are NOT auto-sent in the morning Level-1 summary.
 */
import type { DailyReport } from "@/lib/telegram/dailyReport";
import {
  formatCompactMoney,
  formatMoney,
  formatNumber,
  formatPercent,
  formatSignedMoney,
} from "@/lib/telegram/dailyReport";
import { isMarketplaceFinancialUnavailable } from "@/lib/telegram/dailyReportDisplay";
import { formatCompactSignedMoney } from "@/lib/telegram/ownerReportFormatHelpers";

type MarketplaceMetricsInput = DailyReport["companies"][0]["wb"] & {
  financialUnavailable?: boolean;
  netProfitUnavailable?: boolean;
};
import {
  formatOzonUnclassifiedOwnerWarning,
  parseUnclassifiedAdjustmentAmount,
} from "@/lib/ozon/accrualDayStatus";
import {
  buildLevelComparisonMaps,
  formatMetricDeltaSuffix,
  type LevelDynamics,
} from "@/lib/telegram/ownerReportV3Dynamics";
import { formatMissingCogsCompactBlock } from "@/lib/telegram/ownerReportMissingCogs";

export type OwnerReportV3Messages = {
  message1: string;
  /** Empty for compact auto Level-1; detailed formatter still exported separately. */
  message2: string;
  messageCount: 1 | 2;
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
  /** Multiple sizes when business-wide family aggregate */
  familySizes?: string[] | null;
  isFamilyAggregate?: boolean;
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
  top3Source:
    | "TRUE_ORDERS"
    | "CANONICAL_OZON_ORDERS"
    | "TRUE_SOURCE_GAP"
    | "ERROR"
    | "UNAVAILABLE";
  distinctOrderedArticles?: number;
};

export type OwnerReportV3Extras = {
  businessTop3: TopOrderItem[];
  businessTop3Source:
    | "TRUE_ORDERS"
    | "CANONICAL_OZON_ORDERS"
    | "INCOMPLETE"
    | "TRUE_SOURCE_GAP"
    | "ERROR"
    | "UNAVAILABLE";
  businessTop3CabinetCount: number;
  businessTop3Complete: boolean;
  cabinets: CabinetAdFunnel[];
  /** When set and incomplete, profit is labeled preliminary (known COGS only). */
  cogsCoverage?: import("@/lib/telegram/ownerReportCogsCoverage").OwnerReportCogsCoverageEvidence | null;
  /** Exact-enriched missing COGS rows for morning block (article/size/photo). */
  missingCogsItems?: import("@/lib/telegram/ownerReportMissingCogs").MissingCogsListItem[] | null;
};

/** Cabinets that contribute real order TOP-3 rows to business-wide aggregation. */
export function isTop3SourceAvailable(
  source: CabinetAdFunnel["top3Source"] | OwnerReportV3Extras["businessTop3Source"]
): boolean {
  return source === "TRUE_ORDERS" || source === "CANONICAL_OZON_ORDERS";
}

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

/** DRR safety: denominator <= 0 or unavailable => н/д (never 0% with ads>0 and turnover=0). */
export function formatDrrLabel(params: {
  drr: number;
  denominator: number | null | undefined;
  financialUnavailable?: boolean;
}): string {
  if (params.financialUnavailable) return "н/д";
  const den = params.denominator;
  if (den === null || den === undefined || !Number.isFinite(den) || den <= 0.0001) {
    return "н/д";
  }
  if (!Number.isFinite(params.drr)) return "н/д";
  return pct(params.drr);
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

function ecoOf(m: {
  economicTurnover?: number;
  salesAmount?: number;
  financialUnavailable?: boolean;
}) {
  if (m.financialUnavailable) return null;
  return m.economicTurnover ?? m.salesAmount ?? null;
}

function shortCompanyLabel(companyName: string) {
  return String(companyName ?? "")
    .replace(/^ИП\s+/i, "")
    .trim() || companyName;
}

function metricDeltaFromPair(
  current: number,
  previous: number | null | undefined
): string {
  if (
    previous === null ||
    previous === undefined ||
    !Number.isFinite(previous) ||
    !Number.isFinite(current)
  ) {
    return "";
  }
  if (Math.abs(previous) < 0.0001) {
    return formatMetricDeltaSuffix({
      percent: Math.abs(current) < 0.0001 ? 0 : null,
      fromZero: Math.abs(current) >= 0.0001,
    });
  }
  return formatMetricDeltaSuffix({
    percent: ((current - previous) / Math.abs(previous)) * 100,
  });
}

function formatCompactMarketplaceCabinet(
  emoji: string,
  companyName: string,
  label: string,
  m: MarketplaceMetricsInput,
  dyn: LevelDynamics | null = null,
  profitPreliminary = false,
) {
  const shortName = shortCompanyLabel(companyName);
  const qtyDelta = formatMetricDeltaSuffix({
    percent: dyn?.ordersQtyPercent ?? null,
    fromZero: dyn?.ordersQtyFromZero,
  });
  const amountDelta = formatMetricDeltaSuffix({
    percent: dyn?.ordersAmountPercent ?? null,
    fromZero: dyn?.ordersAmountFromZero,
  });
  const turnoverDelta = formatMetricDeltaSuffix({
    percent: dyn?.economicTurnoverPercent ?? null,
    fromZero: dyn?.economicTurnoverFromZero,
  });
  const unavailable = isMarketplaceFinancialUnavailable(m);

  if (unavailable) {
    return [
      `${emoji} ${shortName} · ${label}`,
      `⚠️ Финансовые данные неполны — не равны 0 ₽.`,
      `🛒 Заказы: ${formatNumber(m.ordersQty)} шт${qtyDelta}`,
      `💳 Сумма заказов: ${compact(m.ordersAmount)}${amountDelta}`,
    ].join("\n");
  }

  const eco = ecoOf(m) ?? 0;
  const profit = m.netProfitUnavailable ? null : m.netProfitAfterTax;
  const marg = profit === null ? null : margin(profit, eco);
  const drrLabel = formatDrrLabel({
    drr: m.drrByEconomicTurnover,
    denominator: ecoOf(m),
    financialUnavailable: unavailable,
  });
  const profitLine =
    profit === null
      ? `💰 Прибыль: недоступна`
      : profitPreliminary
        ? `💰 Прибыль до недостающей себестоимости: ${formatCompactSignedMoney(profit)}${
            marg === null ? "" : ` · ${pct(marg)}`
          }`
        : `💰 Прибыль: ${formatCompactSignedMoney(profit)}${
            marg === null ? "" : ` · ${pct(marg)}`
          }`;

  return [
    `${emoji} ${shortName} · ${label}`,
    `🛒 Заказы: ${formatNumber(m.ordersQty)} шт${qtyDelta}`,
    `💳 Сумма заказов: ${compact(m.ordersAmount)}${amountDelta}`,
    `📈 Оборот: ${compact(eco)}${turnoverDelta}`,
    profitLine,
    `📣 Реклама: ${compact(m.adSpend)} · ДРР ${drrLabel}`,
  ].join("\n");
}

function buildAttentionItems(report: DailyReport): string[] {
  const combinedUnavailable = Boolean(
    (report as { combinedFinancialUnavailable?: boolean })
      .combinedFinancialUnavailable
  );
  const profit = combinedUnavailable ? null : report.totals.netProfitImpact;
  const items: string[] = [];
  const seen = new Set<string>();

  const push = (line: string) => {
    const key = line.replace(/\s+/g, " ").trim().toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    items.push(line);
  };

  if (report.totals.netCashFlow < 0) {
    push(`🔴 Отрицательный ДДС: ${compact(report.totals.netCashFlow)}`);
  }
  if (profit !== null && profit < 0) {
    push(`🔴 Отрицательная прибыль: ${compact(profit)}`);
  }

  // Compact classification warning only — no typeId in owner message.
  let unclassifiedAbs = 0;
  for (const c of report.companies) {
    const amount = parseUnclassifiedAdjustmentAmount(
      (c.ozon as { ozonMissingEvidence?: string | null }).ozonMissingEvidence ??
        null,
    );
    if (amount != null) unclassifiedAbs += amount;
  }
  if (unclassifiedAbs > 0.005) {
    push(`⚠️ ${formatOzonUnclassifiedOwnerWarning(unclassifiedAbs)}`);
  }

  for (const c of sortCompaniesOwnerOrder(report.companies)) {
    for (const item of [
      { mp: "WB" as const, m: c.wb as MarketplaceMetricsInput },
      { mp: "Ozon" as const, m: c.ozon as MarketplaceMetricsInput },
    ]) {
      if (isMarketplaceFinancialUnavailable(item.m)) {
        push(
          `⚠️ ${c.companyName} · ${item.mp}: нет полного финансового источника`
        );
        continue;
      }
      const eco = ecoOf(item.m) ?? 0;
      if (item.m.adSpend > 0 && eco > 0.0001 && item.m.drrByEconomicTurnover >= 10) {
        const tone = item.m.drrByEconomicTurnover >= 12 ? "🟠" : "🟡";
        push(
          `${tone} ${c.companyName} · ${item.mp}: ДРР ${pct(
            item.m.drrByEconomicTurnover
          )}`
        );
      }
      if (
        !item.m.netProfitUnavailable &&
        item.m.netProfitAfterTax < 0 &&
        Math.abs(item.m.netProfitAfterTax) > 0.5
      ) {
        push(
          `🔴 ${c.companyName} · ${item.mp}: прибыль ${formatSignedMoney(
            item.m.netProfitAfterTax
          )}`
        );
      }
    }
  }

  for (const w of report.warnings ?? []) {
    push(`⚠️ ${w}`);
  }

  return items.slice(0, 4);
}

/**
 * Compact Level-1 morning owner summary (single auto message).
 * Includes business TOP-3 + stocks; no COGS/taxable/CTR noise.
 */
export function formatOwnerReportV3Message1(
  report: DailyReport,
  previousReport: DailyReport | null = null,
  extras: OwnerReportV3Extras | null = null
): string {
  const dateIso = primaryDateIso(report);
  const dateRu = formatRuDateIso(dateIso);
  const comparisonDate = report.comparison
    ? formatRuDateIso(
        String(report.comparison.dateLabel).match(/\d{4}-\d{2}-\d{2}/)?.[0] ??
          report.comparison.dateLabel
      )
    : "";

  const prev =
    previousReport ?? report.previousReport ?? null;
  const levelMaps = buildLevelComparisonMaps(report, prev);

  const combinedUnavailable = Boolean(
    (report as { combinedFinancialUnavailable?: boolean })
      .combinedFinancialUnavailable
  );
  const eco = report.totals.economicTurnover;
  const profit = combinedUnavailable ? null : report.totals.netProfitImpact;
  const marg = profit === null ? null : margin(profit, eco);
  const afterOwner =
    profit === null ? null : profit - report.totals.ownerWithdrawals;
  const cmp = report.comparison?.totals ?? null;
  const cogs = extras?.cogsCoverage ?? null;
  const businessCogsIncomplete = Boolean(cogs && !cogs.coverageComplete);
  const turnoverDelta = combinedUnavailable
    ? ""
    : formatMetricDeltaSuffix({
        percent: cmp?.economicTurnoverPercent ?? null,
        fromZero:
          prev != null &&
          Math.abs(prev.totals.economicTurnover) < 0.0001 &&
          Math.abs(eco) >= 0.0001,
      });
  const ordersQtyDelta = metricDeltaFromPair(
    report.totals.ordersQty,
    prev?.totals.ordersQty
  );
  const ordersAmountDelta = metricDeltaFromPair(
    report.totals.ordersAmount,
    prev?.totals.ordersAmount
  );
  const businessDrr = formatDrrLabel({
    drr: report.totals.drrByEconomicTurnover,
    denominator: combinedUnavailable ? null : eco,
    financialUnavailable: combinedUnavailable,
  });
  const businessProfitLine =
    profit === null
      ? `💰 Прибыль: недоступна`
      : businessCogsIncomplete
        ? `💰 Прибыль до недостающей себестоимости: ${compact(profit)}${
            marg === null ? "" : ` · ${pct(marg)}`
          }`
        : `💰 Прибыль: ${compact(profit)}${
            marg === null ? "" : ` · ${pct(marg)}`
          }`;

  const lines: string[] = [
    `📊 AvoroFin — ${dateRu}`,
    comparisonDate ? `vs ${comparisonDate}` : "",
    "",
    `🏢 ГЛАВНОЕ`,
    combinedUnavailable
      ? `📈 Оборот: недоступен`
      : `📈 Оборот: ${compact(eco)}${turnoverDelta}`,
    businessProfitLine,
    afterOwner === null
      ? `💵 После вывода: недоступна`
      : businessCogsIncomplete
        ? `💵 После вывода (предварительно): ${compact(afterOwner)}`
        : `💵 После вывода: ${compact(afterOwner)}`,
    combinedUnavailable
      ? `📣 Реклама: недоступна`
      : `📣 Реклама: ${compact(report.totals.adSpend)} · ДРР ${businessDrr}`,
    `💸 ДДС: ${compact(report.totals.netCashFlow)}`,
    `🛒 Заказы: ${formatNumber(report.totals.ordersQty)} шт${ordersQtyDelta}`,
    `💳 Сумма заказов: ${compact(report.totals.ordersAmount)}${ordersAmountDelta}`,
  ].filter(Boolean);

  const attention = buildAttentionItems(report);
  if (attention.length > 0) {
    lines.push("", "⚠️ ТРЕБУЕТ ВНИМАНИЯ", ...attention);
  }

  lines.push("", "🏪 ПО МАРКЕТПЛЕЙСАМ", "");
  for (const company of sortCompaniesOwnerOrder(report.companies)) {
    const wbDyn =
      levelMaps.cabinet.get(`${company.companyName}::WB`) ?? null;
    const ozDyn =
      levelMaps.cabinet.get(`${company.companyName}::OZON`) ?? null;
    const wbIncomplete = Boolean(
      cogs?.marketplaces.some(
        (m) =>
          m.companyName === company.companyName &&
          m.marketplace === "WB" &&
          !m.coverageComplete,
      ),
    );
    const ozIncomplete = Boolean(
      cogs?.marketplaces.some(
        (m) =>
          m.companyName === company.companyName &&
          m.marketplace === "OZON" &&
          !m.coverageComplete,
      ),
    );
    lines.push(
      formatCompactMarketplaceCabinet(
        "🟣",
        company.companyName,
        "WB",
        company.wb,
        wbDyn,
        wbIncomplete,
      ),
      "",
      formatCompactMarketplaceCabinet(
        "🔵",
        company.companyName,
        "Ozon",
        company.ozon,
        ozDyn,
        ozIncomplete,
      ),
      ""
    );
  }

  if (extras) {
    const top = extras.businessTop3.slice(0, 3);
    if (!extras.businessTop3Complete) {
      lines.push(
        escapeTelegramHtml("🏆 ТОП-3 по доступным данным — неполно"),
        formatTop3List(top, true, "business")
      );
    } else {
      lines.push(
        escapeTelegramHtml("🏆 ТОП-3 ТОВАРА"),
        formatTop3List(top, true, "business")
      );
    }
    lines.push("");
  }

  if (cogs && !cogs.coverageComplete) {
    const missingBlock = formatMissingCogsCompactBlock(
      cogs,
      extras?.missingCogsItems ?? null,
    );
    if (missingBlock) {
      lines.push("", missingBlock);
    }
  }

  lines.push(`📦 Остатки: ${formatNumber(report.totals.stockQty)} шт`);
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
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

function formatTop3List(
  items: TopOrderItem[],
  asHtml: boolean,
  mode: "cabinet" | "business" = "cabinet"
) {
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
      const photo = asHtml
        ? photoIconHtml(it.imageUrl)
        : it.imageUrl
          ? " 📷"
          : "";

      // Business-wide family aggregate: human/family label + sizes row
      if (mode === "business" && it.isFamilyAggregate) {
        const label = it.humanArticle || it.article;
        const sizes =
          it.familySizes && it.familySizes.length > 0
            ? `разм. ${it.familySizes.join("/")}`
            : null;
        const head = `${i + 1}. ${esc(label)} — ${esc(qtyAmt)}${photo}`;
        return sizes ? `${head}\n   ${esc(sizes)}` : head;
      }

      if (
        mode === "cabinet" &&
        (it.marketplace === "OZON" || it.ozonOffer || it.humanArticle)
      ) {
        const offer = it.ozonOffer || it.article;
        const parts = [offer];
        if (it.humanArticle && it.humanArticle !== offer) {
          parts.push(it.humanArticle);
        }
        if (it.size) parts.push(`р.${it.size}`);
        const head = `${i + 1}. ${parts.map(esc).join(" · ")}${photo}`;
        return `${head}\n   ${esc(qtyAmt)}`;
      }

      // WB cabinet / non-family business row
      const label =
        mode === "business" && it.humanArticle
          ? it.humanArticle
          : it.article;
      const sep = mode === "business" ? " — " : " · ";
      return `${i + 1}. ${esc(label)}${sep}${esc(qtyAmt)}${photo}`;
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
  const spendUnavailable =
    funnel.counterStatus === "COUNTERS_MISSING" &&
    !(funnel.spend > 0.0001) &&
    !(funnel.financialSpend > 0.0001);
  if (spendUnavailable) {
    lines.push(`Расход      н/д`);
    lines.push(`ДРР         н/д`);
    lines.push(`Показы      н/д`);
    lines.push(`Клики       н/д`);
    return lines.join("\n");
  }
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
      `Реклама P&L: ${money(funnel.financialSpend)} · ДРР ${formatDrrLabel({
        drr: funnel.financialDrr,
        denominator: funnel.economicTurnover,
      })}`
    );
  } else {
    lines.push(
      `Расход      ${money(funnel.spend)} · ДРР ${formatDrrLabel({
        drr: funnel.drr,
        denominator: funnel.economicTurnover,
      })}`
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
      formatTop3List(top, true, "business")
    );
  } else {
    parts.push(
      esc(`🏆 ТОП-3 ПО ВСЕМУ БИЗНЕСУ`),
      "",
      formatTop3List(top, true, "business")
    );
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
        formatTop3List(funnel?.top3 ?? [], true, "cabinet"),
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
    message1: formatOwnerReportV3Message1(report, previousReport, extras),
    // Compact auto Level-1 is a single owner-facing message.
    message2: "",
    messageCount: 1,
  };
}

/** Pure helpers exported for tests */
export const ownerReportV3Math = {
  share,
  margin,
  safeDiv,
  sortCompaniesOwnerOrder,
  escapeTelegramHtml,
  formatDrrLabel,
};
